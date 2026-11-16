/* Local cache diagnostics; SPDX-License-Identifier: MPL-2.0 */
'use strict';
const { Transform } = require('node:stream');
const { sanitizeCacheBoundaryEvidence } = require('./cache-prefix-boundary.cjs');

const MAX_PREVIEW_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_CONTENTS = 64;
const MAX_STORED_GOOGLE_REQUESTS = 3;
const PART_KINDS = ['text', 'inlineData', 'fileData', 'functionCall', 'functionResponse', 'executableCode', 'codeExecutionResult'];

function unavailable(reason, bodyBytes = null) {
    return { version: 1, status: 'unavailable', reason, bodyBytes };
}

/** Body-free projection of the exact outbound Google JSON, never a rewrite. */
function summarizeGoogleRequest(bytes, { fingerprint, epoch, bodyBytes, reason, cacheBoundary } = {}) {
    const length = bodyBytes ?? (Buffer.isBuffer(bytes) ? bytes.length : null);
    if (reason) return unavailable(reason, length);
    if (!Buffer.isBuffer(bytes)) return unavailable('BODY_UNAVAILABLE', length);
    if (bytes.length > MAX_PREVIEW_BODY_BYTES) return unavailable('BODY_TOO_LARGE', bytes.length);
    try {
        const body = JSON.parse(bytes.toString('utf8'));
        if (!body || Array.isArray(body) || !Array.isArray(body.contents)) return unavailable('UNSUPPORTED_GOOGLE_SHAPE', bytes.length);
        if (typeof fingerprint !== 'function' || typeof epoch !== 'string') return unavailable('FINGERPRINT_UNAVAILABLE', bytes.length);
        const describe = (content, role) => {
            if (!content || typeof content !== 'object' || !Array.isArray(content.parts)) throw new Error('Invalid content');
            const kinds = {};
            let textChars = 0, textBytes = 0, thoughtParts = 0, signedParts = 0;
            for (const part of content.parts) {
                if (!part || typeof part !== 'object' || Array.isArray(part)) throw new Error('Invalid part');
                let recognized = false;
                for (const kind of PART_KINDS) if (Object.hasOwn(part, kind)) {
                    recognized = true;
                    kinds[kind] = (kinds[kind] ?? 0) + 1;
                }
                if (!recognized) kinds.other = (kinds.other ?? 0) + 1;
                if (typeof part.text === 'string') { textChars += part.text.length; textBytes += Buffer.byteLength(part.text); }
                if (part.thought === true) thoughtParts++;
                if (typeof part.thoughtSignature === 'string') signedParts++;
            }
            const textSegments = content.parts.flatMap((part, index) => typeof part.text === 'string'
                ? [{ part: index + 1, textChars: part.text.length, fingerprint: fingerprint(part.text) }] : []);
            return { role, partCount: content.parts.length, textChars, textBytes, kinds, thoughtParts, signedParts,
                textSegments: textSegments.slice(0, 64), omittedTextSegments: Math.max(0, textSegments.length - 64),
                fingerprint: fingerprint(JSON.stringify(content)) };
        };
        const instruction = body.systemInstruction ?? body.system_instruction;
        const systemInstruction = instruction == null ? null : describe(instruction, 'system');
        const contents = body.contents.slice(0, MAX_PREVIEW_CONTENTS).map((content, index) => ({ index,
            ...describe(content, ['user', 'model'].includes(content?.role) ? content.role : 'unknown') }));
        const parameters = { ...body };
        delete parameters.contents; delete parameters.systemInstruction; delete parameters.system_instruction;
        // Billing/observability labels do not change model prompt or generation parameters.
        delete parameters.labels;
        const config = body.generationConfig ?? body.generation_config;
        const generation = {};
        for (const key of ['maxOutputTokens', 'temperature', 'topP', 'topK', 'candidateCount', 'seed']) {
            if (typeof config?.[key] === 'number' && Number.isFinite(config[key])) generation[key] = config[key];
        }
        let boundary;
        const evidence = sanitizeCacheBoundaryEvidence(cacheBoundary);
        if (evidence && body.contents[evidence.block - 1]?.parts?.length >= evidence.part) {
            const boundaryParts = body.contents[evidence.block - 1].parts.slice(0, evidence.part - 1);
            const prefix = [...(instruction ? [{ ...instruction, role: 'system' }] : []), ...body.contents.slice(0, evidence.block - 1),
                ...(boundaryParts.length ? [{ ...body.contents[evidence.block - 1], parts: boundaryParts }] : [])];
            const textChars = prefix.reduce((sum, content) => sum + content.parts.reduce((n, part) => n + (typeof part.text === 'string' ? part.text.length : 0), 0), 0);
            if (textChars === evidence.stableTextChars) boundary = { ...evidence, stableFingerprint: fingerprint(JSON.stringify(prefix)) };
        }
        return { version: 1, status: 'available', bodyBytes: bytes.length, epoch,
            bodyFingerprint: fingerprint(bytes), parametersFingerprint: fingerprint(JSON.stringify(parameters)),
            systemInstruction, contentCount: body.contents.length, contents,
            ...(boundary ? { cacheBoundary: boundary } : {}),
            omittedContents: Math.max(0, body.contents.length - contents.length), generation,
            toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
            hasExplicitCache: typeof (body.cachedContent ?? body.cached_content) === 'string',
            hasContinuationToken: typeof body.continuationToken === 'string',
            serviceTier: ['flex', 'standard', 'priority'].includes(body.service_tier ?? body.serviceTier)
                ? body.service_tier ?? body.serviceTier : null };
    } catch { return unavailable('INVALID_OR_UNSUPPORTED_JSON', length); }
}

// Tap AFTER the tier transform. Forward every byte unchanged and immediately;
// collect at most 2 MiB for diagnostics, then discard rather than truncate JSON.
class GoogleRequestPreviewTap extends Transform {
    constructor({ onComplete, maxBytes = MAX_PREVIEW_BODY_BYTES } = {}) {
        super(); this.onComplete = onComplete; this.maxBytes = maxBytes;
        this.chunks = []; this.total = 0; this.oversized = false;
    }
    _transform(chunk, _encoding, callback) {
        this.total += chunk.length;
        if (!this.oversized && this.total <= this.maxBytes) this.chunks.push(chunk);
        else { this.oversized = true; this.chunks = []; }
        callback(null, chunk);
    }
    _flush(callback) {
        const bytes = this.oversized ? null : Buffer.concat(this.chunks);
        this.chunks = [];
        try { this.onComplete?.(bytes, { bodyBytes: this.total, ...(this.oversized ? { reason: 'BODY_TOO_LARGE' } : {}) }); }
        catch { /* Observation must never fail the user's generation. */ }
        callback();
    }
    _destroy(error, callback) { this.chunks = []; callback(error); }
}
module.exports = { summarizeGoogleRequest, GoogleRequestPreviewTap, MAX_PREVIEW_BODY_BYTES,
    MAX_PREVIEW_CONTENTS, MAX_STORED_GOOGLE_REQUESTS };
