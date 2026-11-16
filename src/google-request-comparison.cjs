/* Bounded, memory-only wire comparisons; SPDX-License-Identifier: MPL-2.0 */
'use strict';

const MAX_COMPARISON_BODY_BYTES = 2 * 1024 * 1024;
const { isDeepStrictEqual: same } = require('node:util');
const instruction = body => body.systemInstruction ?? body.system_instruction ?? null;

function parseBody(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_COMPARISON_BODY_BYTES) return null;
    try {
        const body = JSON.parse(bytes.toString('utf8'));
        if (!body || !Array.isArray(body.contents) || body.contents.length > 512) return null;
        for (const content of [instruction(body), ...body.contents].filter(Boolean)) {
            if (!Array.isArray(content.parts) || content.parts.length > 4096
                || content.parts.some(part => !part || typeof part !== 'object' || Array.isArray(part))) return null;
        }
        return body;
    } catch { return null; }
}

/** Compare the same ordered role/part structure. The result contains no text,
 * byte slices, hashes usable outside the existing per-user HMAC, or token estimate. */
function compareGoogleRequests(previousBytes, currentBytes) {
    const previous = parseBody(previousBytes), current = parseBody(currentBytes);
    if (!previous || !current) return null;
    let commonTextChars = 0, systemTextPrefixChars = 0, firstDifference = null;
    const difference = (field, block, part, offset, kind) => {
        firstDifference = { field, block, part, offset, kind };
        return false;
    };
    const compareContent = (left, right, field, block) => {
        if (!left || !right) return left === right || difference(field, block, null, null, 'structure');
        if (field === 'contents' && left.role !== right.role) return difference(field, block, null, null, 'role');
        const length = Math.min(left.parts.length, right.parts.length);
        for (let index = 0; index < length; index++) {
            const before = left.parts[index], after = right.parts[index];
            const beforeMeta = { ...before }, afterMeta = { ...after };
            delete beforeMeta.text; delete afterMeta.text;
            if (!same(beforeMeta, afterMeta)) return difference(field, block, index + 1, null, 'structure');
            if (typeof before.text === 'string' && typeof after.text === 'string') {
                let offset = 0;
                while (offset < Math.min(before.text.length, after.text.length) && before.text[offset] === after.text[offset]) offset++;
                commonTextChars += offset;
                if (field === 'systemInstruction') systemTextPrefixChars += offset;
                if (offset !== before.text.length || offset !== after.text.length) return difference(field, block, index + 1, offset, 'text');
            } else if (before.text !== after.text) return difference(field, block, index + 1, null, 'structure');
        }
        return left.parts.length === right.parts.length || difference(field, block, length + 1, null, 'structure');
    };
    if (compareContent(instruction(previous), instruction(current), 'systemInstruction', null)) {
        const length = Math.min(previous.contents.length, current.contents.length);
        let index = 0;
        for (; index < length; index++) if (!compareContent(previous.contents[index], current.contents[index], 'contents', index + 1)) break;
        if (!firstDifference && previous.contents.length !== current.contents.length) difference('contents', length + 1, null, null, 'structure');
    }
    return { commonTextChars, systemTextPrefixChars, firstDifference };
}

function confirmedWorldInfoSource(bytes, firstDifference, plan) {
    if (firstDifference?.kind !== 'text' || !plan || !Array.isArray(plan.groups)) return null;
    const body = parseBody(bytes);
    const content = firstDifference.field === 'systemInstruction' ? instruction(body ?? {}) : body?.contents[firstDifference.block - 1];
    const text = content?.parts?.[firstDifference.part - 1]?.text;
    if (typeof text !== 'string') return null;
    const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
    let source = null;
    for (const group of plan.groups) for (const item of group.items ?? []) {
        if (!safeId(group.id) || !safeId(item.id) || typeof item.text !== 'string' || !item.text) continue;
        const index = text.indexOf(item.text);
        if (index === -1 || text.indexOf(item.text, index + 1) !== -1
            || firstDifference.offset < index || firstDifference.offset >= index + item.text.length) continue;
        if (source) return null;
        source = { kind: 'worldinfo', groupId: group.id, itemId: item.id };
    }
    return source;
}

class GoogleRequestComparisonStore {
    constructor({ now = Date.now, ttlMs = 300_000, maxEntries = 16, maxBytes = 8 * 1024 * 1024 } = {}) {
        for (const value of [ttlMs, maxEntries, maxBytes]) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid comparison limits');
        Object.assign(this, { now, ttlMs, maxEntries, maxBytes });
        this.entries = new Map(); this.bytes = 0; this.closed = false;
        this.timer = setInterval(() => this.sweep(), Math.min(ttlMs, 10_000)); this.timer.unref?.();
    }
    drop(id) {
        const entry = this.entries.get(id);
        if (!entry) return;
        this.bytes -= entry.bytes.length;
        // Wipe this owned copy before releasing it; callers' transport buffers are untouched.
        entry.bytes.fill(0); this.entries.delete(id);
    }
    sweep() { for (const [id, entry] of this.entries) if (this.now() >= entry.expires) this.drop(id); }
    capture({ scope, id, bytes, isComplete = () => true, worldInfoOrder } = {}) {
        if (this.closed) return null;
        this.sweep();
        if (typeof scope !== 'string' || typeof id !== 'string' || !parseBody(bytes) || bytes.length > this.maxBytes) return null;
        let comparison = null;
        for (const previous of [...this.entries.values()].reverse()) {
            if (previous.scope !== scope || previous.id === id || !isComplete(previous.id)) continue;
            const details = compareGoogleRequests(previous.bytes, bytes);
            if (details) comparison = { version: 1, status: 'compared', previousId: previous.id, ...details,
                sourceHint: confirmedWorldInfoSource(bytes, details.firstDifference, worldInfoOrder) };
            break;
        }
        this.drop(id);
        while (this.entries.size >= this.maxEntries || this.bytes + bytes.length > this.maxBytes) this.drop(this.entries.keys().next().value);
        const copy = Buffer.from(bytes);
        this.entries.set(id, { scope, id, bytes: copy, expires: this.now() + this.ttlMs }); this.bytes += copy.length;
        return comparison;
    }
    close() { this.closed = true; clearInterval(this.timer); for (const id of [...this.entries.keys()]) this.drop(id); }
}

module.exports = { compareGoogleRequests, GoogleRequestComparisonStore, confirmedWorldInfoSource };
