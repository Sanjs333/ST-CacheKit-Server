/* Source-bound, role-preserving Google text boundaries; SPDX-License-Identifier: MPL-2.0 */
'use strict';
const { createHash, randomBytes } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const BOUNDARY_FIELD = '__vertexPayGoCacheBoundary';
const EVIDENCE_FIELD = '__vertexPayGoCacheBoundaryEvidence';
const MAX_BOUNDARY_BYTES = 2 * 1024 * 1024;
const FIELDS = ['version', 'messageIndex', 'textPartIndex', 'offset', 'messagesHash', 'sourceId'];
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const textAt = (message, part) => typeof message?.content === 'string' && part === null ? message.content
    : Array.isArray(message?.content) && Number.isSafeInteger(part)
        && message.content[part]?.type === 'text' && typeof message.content[part]?.text === 'string' ? message.content[part].text : null;

function validateCacheBoundary(messages, value) {
    try {
        if (!Array.isArray(messages) || !messages.length || messages.length > 512
            || !value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).some(key => !FIELDS.includes(key)) || value.version !== 1
            || !integer(value.messageIndex, messages.length - 1) || !integer(value.offset, MAX_BOUNDARY_BYTES)
            || typeof value.messagesHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.messagesHash)
            || value.sourceId !== undefined && (typeof value.sourceId !== 'string' || !/^prompt:chatHistory-[0-9]{1,9}$/.test(value.sourceId))) return null;
        const message = messages[value.messageIndex];
        if (!['user', 'assistant'].includes(message?.role)) return null;
        if (typeof message.content === 'string' ? value.textPartIndex !== null
            : !Array.isArray(message.content) || !integer(value.textPartIndex, message.content.length - 1)) return null;
        const text = textAt(message, value.textPartIndex);
        if (text === null || value.offset >= text.length) return null;
        // A non-text history part before this text would make its start ambiguous.
        if (Array.isArray(message.content) && message.content.slice(0, value.textPartIndex).some(part => part?.type !== 'text')) return null;
        const raw = JSON.stringify(messages);
        if (Buffer.byteLength(raw) > MAX_BOUNDARY_BYTES || createHash('sha256').update(raw).digest('hex') !== value.messagesHash) return null;
        return { messageIndex: value.messageIndex, textPartIndex: value.textPartIndex, offset: value.offset };
    } catch { return null; }
}

/** Validate against the exact incoming messages; insert only into a clone. */
function prepareCacheBoundary(original, prepared, value, { markerFactory = () => 'STCKBOUNDARY_' + randomBytes(16).toString('hex') + '_END' } = {}) {
    const boundary = validateCacheBoundary(original, value);
    if (!boundary) return null;
    try {
        const before = original[boundary.messageIndex], after = prepared[boundary.messageIndex];
        // Signature restoration can move text offsets. Do not guess a new offset.
        if (before?.role !== after?.role || !isDeepStrictEqual(before?.content, after?.content)) return null;
        const marker = markerFactory();
        if (typeof marker !== 'string' || !/^STCKBOUNDARY_[a-f0-9]{32}_END$/.test(marker)
            || JSON.stringify(prepared).includes(marker)) return null;
        const messages = structuredClone(prepared), message = messages[boundary.messageIndex];
        const text = textAt(message, boundary.textPartIndex);
        const marked = text.slice(0, boundary.offset) + marker + text.slice(boundary.offset);
        if (boundary.textPartIndex === null) message.content = marked;
        else message.content[boundary.textPartIndex].text = marked;
        return { ...boundary, marker, messages };
    } catch { return null; }
}

const plainText = part => part && typeof part.text === 'string' && Object.keys(part).every(key => key === 'text');
function normalizedParts(parts) {
    const result = [];
    for (const part of parts ?? []) {
        if (plainText(part) && plainText(result.at(-1))) result.at(-1).text += part.text;
        else result.push(structuredClone(part));
    }
    return result;
}
function normalizedPrompt(prompt) {
    const result = structuredClone(prompt);
    for (const content of [result.system_instruction, result.systemInstruction, ...(result.contents || [])].filter(Boolean)) {
        content.parts = normalizedParts(content.parts);
    }
    return result;
}

/** Keep the original transformed request if the marker is lost or ambiguous. */
function resolveCacheBoundary(baseline, marked, plan) {
    if (!plan) return { prompt: baseline, evidence: null };
    try {
        const raw = JSON.stringify(marked);
        if (raw.split(plan.marker).length !== 2) return { prompt: baseline, evidence: null };
        const prompt = structuredClone(marked), locations = [];
        for (let block = 0; block < (prompt.contents?.length ?? 0); block++) {
            const content = prompt.contents[block];
            for (let part = 0; part < (content.parts?.length ?? 0); part++) {
                if (typeof content.parts[part]?.text === 'string' && content.parts[part].text.includes(plan.marker)) locations.push({ block, part });
            }
        }
        if (locations.length !== 1) return { prompt: baseline, evidence: null };
        const location = locations[0], content = prompt.contents[location.block], part = content.parts[location.part];
        const offset = part.text.indexOf(plan.marker), prefix = part.text.slice(0, offset), suffix = part.text.slice(offset + plan.marker.length);
        const split = prefix.length > 0 && suffix.length > 0;
        if (split && !plainText(part)) return { prompt: baseline, evidence: null };
        if (split) content.parts.splice(location.part, 1, { text: prefix }, { text: suffix });
        else part.text = prefix + suffix;
        if (JSON.stringify(prompt).includes(plan.marker)
            || !isDeepStrictEqual(normalizedPrompt(baseline), normalizedPrompt(prompt))) return { prompt: baseline, evidence: null };
        let stableTextChars = 0;
        for (const instruction of [prompt.system_instruction, prompt.systemInstruction].filter(Boolean)) {
            for (const item of instruction.parts ?? []) if (typeof item.text === 'string') stableTextChars += item.text.length;
        }
        for (let block = 0; block < location.block; block++) for (const item of prompt.contents[block].parts ?? []) {
            if (typeof item.text === 'string') stableTextChars += item.text.length;
        }
        for (let index = 0; index < location.part; index++) if (typeof content.parts[index].text === 'string') stableTextChars += content.parts[index].text.length;
        stableTextChars += prefix.length;
        return { prompt, evidence: { version: 1, status: split ? 'split' : 'already-separated',
            historyMessageIndex: plan.messageIndex, block: location.block + 1,
            part: location.part + (split ? 2 : 1), stableTextChars } };
    } catch { return { prompt: baseline, evidence: null }; }
}

function sanitizeCacheBoundaryEvidence(value, body) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.version !== 1 || !['split', 'already-separated'].includes(value.status)
        || !integer(value.historyMessageIndex, 511) || !integer(value.block, 513) || value.block < 1
        || !integer(value.part, 8192) || value.part < 1 || !integer(value.stableTextChars, MAX_BOUNDARY_BYTES)) return undefined;
    if (body !== undefined) {
        if (!Array.isArray(body?.contents) || body.contents.some(content => !content || !Array.isArray(content.parts))) return undefined;
        const content = body?.contents?.[value.block - 1], part = content?.parts?.[value.part - 1];
        if (!part || typeof part.text !== 'string' || !part.text
            || value.status === 'split' && (value.part < 2 || !plainText(part) || !plainText(content.parts[value.part - 2]))) return undefined;
        let stableTextChars = 0;
        const instruction = body.systemInstruction ?? body.system_instruction;
        if (instruction != null && !Array.isArray(instruction.parts)) return undefined;
        for (const item of instruction?.parts ?? []) if (typeof item.text === 'string') stableTextChars += item.text.length;
        for (const earlier of body.contents.slice(0, value.block - 1)) for (const item of earlier.parts ?? []) {
            if (typeof item.text === 'string') stableTextChars += item.text.length;
        }
        for (const item of content.parts.slice(0, value.part - 1)) if (typeof item.text === 'string') stableTextChars += item.text.length;
        if (stableTextChars !== value.stableTextChars) return undefined;
    }
    return { version: 1, status: value.status, historyMessageIndex: value.historyMessageIndex,
        block: value.block, part: value.part, stableTextChars: value.stableTextChars };
}

module.exports = { BOUNDARY_FIELD, EVIDENCE_FIELD, validateCacheBoundary, prepareCacheBoundary, resolveCacheBoundary, sanitizeCacheBoundaryEvidence };
