'use strict';

const { StringDecoder } = require('node:string_decoder');

const COUNT_FIELDS = Object.freeze([
    'promptTokenCount', 'cachedContentTokenCount', 'candidatesTokenCount',
    'thoughtsTokenCount', 'toolUsePromptTokenCount', 'totalTokenCount',
]);
const DETAIL_FIELDS = Object.freeze([
    'promptTokensDetails', 'cacheTokensDetails', 'candidatesTokensDetails', 'toolUsePromptTokensDetails',
]);

function sanitizeDetails(value) {
    if (!Array.isArray(value)) return undefined;
    const result = [];
    for (const item of value.slice(0, 32)) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const clean = {};
        if (typeof item.modality === 'string' && item.modality.length <= 64) clean.modality = item.modality;
        if (Number.isSafeInteger(item.tokenCount) && item.tokenCount >= 0) clean.tokenCount = item.tokenCount;
        if (Object.keys(clean).length) result.push(clean);
    }
    return result.length ? result : undefined;
}

function sanitizeUsage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const usage = {};
    const invalidUsageFields = [];
    for (const field of COUNT_FIELDS) {
        if (Number.isSafeInteger(value[field]) && value[field] >= 0) usage[field] = value[field];
        else if (Object.hasOwn(value, field) && value[field] !== undefined) invalidUsageFields.push(field);
    }
    for (const field of DETAIL_FIELDS) {
        const details = sanitizeDetails(value[field]);
        if (details) usage[field] = details;
    }
    if (typeof value.trafficType === 'string' && value.trafficType.length <= 64) usage.trafficType = value.trafficType;
    if (!Object.keys(usage).length && !invalidUsageFields.length) return null;
    if (invalidUsageFields.length) usage.invalidUsageFields = invalidUsageFields;
    // Zero inference belongs to successful, complete official responses only.
    usage.cacheCountStatus = invalidUsageFields.includes('cachedContentTokenCount')
        || usage.cachedContentTokenCount > usage.promptTokenCount ? 'invalid'
        : usage.cachedContentTokenCount === undefined ? 'omitted' : 'reported';
    if (usage.cacheCountStatus === 'reported') usage.cacheCountSource = 'upstream';
    return usage;
}

/** Merge cumulative snapshots from ONE request. Never add stream frames. */
function mergeUsage(previous, value, { sanitized = false } = {}) {
    const incoming = sanitized ? value : sanitizeUsage(value);
    if (!incoming) return previous ? { ...previous } : null;
    const usage = { ...(previous || {}) };
    for (const field of COUNT_FIELDS) {
        if (incoming[field] !== undefined) usage[field] = Math.max(usage[field] ?? 0, incoming[field]);
    }
    for (const field of DETAIL_FIELDS) {
        if (!incoming[field]) continue;
        const details = new Map((usage[field] || []).map(item => [item.modality, { ...item }]));
        for (const item of incoming[field]) {
            const old = details.get(item.modality);
            details.set(item.modality, { ...old, ...item,
                ...(item.tokenCount !== undefined || old?.tokenCount !== undefined
                    ? { tokenCount: Math.max(old?.tokenCount ?? 0, item.tokenCount ?? 0) } : {}) });
        }
        usage[field] = [...details.values()];
    }
    if (incoming.trafficType !== undefined) usage.trafficType = incoming.trafficType;
    const invalid = [...new Set([...(previous?.invalidUsageFields || []), ...(incoming.invalidUsageFields || [])])];
    if (invalid.length) usage.invalidUsageFields = invalid;
    usage.cacheCountStatus = previous?.cacheCountStatus === 'invalid' || incoming.cacheCountStatus === 'invalid'
        || usage.cachedContentTokenCount > usage.promptTokenCount ? 'invalid'
        : usage.cachedContentTokenCount === undefined ? 'omitted' : 'reported';
    if (usage.cacheCountStatus === 'reported') usage.cacheCountSource = 'upstream';
    else delete usage.cacheCountSource;
    return usage;
}

/** Complete official ProtoJSON omits its non-optional integer's zero value. */
function finalizeGoogleUsage(value, { officialGoogle = false, complete = false } = {}) {
    if (!value) return null;
    const usage = { ...value };
    const valid = field => Number.isSafeInteger(usage[field]) && usage[field] >= 0;
    if (usage.cacheCountStatus === 'omitted' && officialGoogle && complete
        && valid('promptTokenCount') && valid('candidatesTokenCount')
        && !(usage.invalidUsageFields?.length)
        && !(usage.cacheTokensDetails || []).some(item => item.tokenCount > 0)) {
        usage.cachedContentTokenCount = 0;
        usage.cacheCountStatus = 'reported';
        usage.cacheCountSource = 'google-default-zero';
    }
    return usage;
}

function usageFromJson(value) {
    if (Array.isArray(value)) {
        let latest = null;
        for (const item of value) latest = mergeUsage(latest, usageFromJson(item), { sanitized: true });
        return latest;
    }
    return sanitizeUsage(value?.usageMetadata);
}

class TopLevelUsageScanner {
    constructor(limit) {
        this.limit = limit;
        this.depth = 0;
        this.inString = false;
        this.escape = false;
        this.expectKey = false;
        this.readingKey = false;
        this.key = '';
        this.pendingKey = null;
        this.awaitingUsage = false;
        this.capture = null;
        this.captureDepth = 0;
        this.captureInString = false;
        this.captureEscape = false;
        this.usage = null;
        this.limitExceeded = false;
    }

    write(text) {
        for (const character of text) this.#character(character);
    }

    #character(character) {
        if (this.capture !== null) {
            if (this.capture.length < this.limit) this.capture += character;
            else this.limitExceeded = true;
            if (this.captureInString) {
                if (this.captureEscape) this.captureEscape = false;
                else if (character === '\\') this.captureEscape = true;
                else if (character === '"') this.captureInString = false;
            } else if (character === '"') this.captureInString = true;
            else if (character === '{') this.captureDepth += 1;
            else if (character === '}' && --this.captureDepth === 0) {
                if (!this.limitExceeded) {
                    try { this.usage = mergeUsage(this.usage, JSON.parse(this.capture)); } catch {                                  }
                }
                this.capture = null;
            }
        }

        if (this.inString) {
            if (this.escape) this.escape = false;
            else if (character === '\\') this.escape = true;
            else if (character === '"') {
                this.inString = false;
                if (this.readingKey) {
                    this.pendingKey = this.key;
                    this.readingKey = false;
                    this.expectKey = false;
                }
            } else if (this.readingKey && this.key.length < 64) this.key += character;
            return;
        }
        if (character === '"') {
            this.inString = true;
            if (this.depth === 1 && this.expectKey) {
                this.readingKey = true;
                this.key = '';
            }
            return;
        }
        if (character === '{') {
            this.depth += 1;
            if (this.depth === 1) this.expectKey = true;
            if (this.awaitingUsage && this.depth === 2) {
                this.capture = '{';
                this.captureDepth = 1;
                this.captureInString = false;
                this.captureEscape = false;
                this.awaitingUsage = false;
            }
            return;
        }
        if (character === '}') {
            this.depth = Math.max(0, this.depth - 1);
            return;
        }
        if (this.depth === 1 && character === ':' && this.pendingKey) {
            this.awaitingUsage = this.pendingKey === 'usageMetadata';
            this.pendingKey = null;
            return;
        }
        if (this.depth === 1 && character === ',') {
            this.expectKey = true;
            this.pendingKey = null;
            this.awaitingUsage = false;
        }
    }
}

class UsageCapture {
    constructor({ stream, maxBufferBytes = 256 * 1024, officialGoogle = false } = {}) {
        this.stream = stream;
        this.officialGoogle = officialGoogle;
        this.terminalSeen = false;
        this.upstreamError = false;
        this.maxBufferBytes = maxBufferBytes;
        this.buffer = '';
        this.decoder = new StringDecoder('utf8');
        this.usage = null;
        this.limitExceeded = false;
        this.droppingEvent = false;
        this.scanner = stream ? null : new TopLevelUsageScanner(maxBufferBytes);
    }

    #merge(usage) {
        if (usage) {
            this.usage = mergeUsage(this.usage, usage, { sanitized: true });
        }
    }

    #event(event) {
        const data = event.split(/\r?\n/u).filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') return;
        try {
            const parsed = JSON.parse(data);
            this.upstreamError ||= !!parsed?.error;
            this.terminalSeen ||= !!parsed?.promptFeedback?.blockReason
                || (parsed?.candidates || []).some(candidate => !!candidate?.finishReason);
            this.#merge(usageFromJson(parsed));
        } catch { /* Non-JSON stream events do not supply usage. */ }
    }

    #streamText(text) {
        this.buffer += text;
        for (;;) {
            const match = /\r?\n\r?\n/u.exec(this.buffer);
            if (!match) break;
            const event = this.buffer.slice(0, match.index);
            this.buffer = this.buffer.slice(match.index + match[0].length);
            if (!this.droppingEvent && Buffer.byteLength(event) <= this.maxBufferBytes) this.#event(event);
            else if (!this.droppingEvent) this.limitExceeded = true;
            this.droppingEvent = false;
        }
        if (Buffer.byteLength(this.buffer) > this.maxBufferBytes) {
            this.limitExceeded = true;
            this.droppingEvent = true;
            this.buffer = this.buffer.slice(-3);
        }
    }

    write(chunk) {
        const text = this.decoder.write(chunk);
        if (this.stream) this.#streamText(text);
        else this.scanner.write(text);
    }

    finish({ complete = false } = {}) {
        const tail = this.decoder.end();
        if (this.stream) {
            this.#streamText(tail);
            if (this.buffer && !this.droppingEvent) this.#event(this.buffer);
        } else {
            this.scanner.write(tail);
            this.#merge(this.scanner.usage);
            this.limitExceeded ||= this.scanner.limitExceeded;
        }
        this.buffer = '';
        return finalizeGoogleUsage(this.usage, { officialGoogle: this.officialGoogle,
            complete: complete && !this.limitExceeded && !this.upstreamError && (!this.stream || this.terminalSeen) });
    }
}

module.exports = { TopLevelUsageScanner, UsageCapture, sanitizeUsage, usageFromJson, mergeUsage, finalizeGoogleUsage };
