'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { setImmediate: yieldToServer } = require('node:timers/promises');
const { randomUUID, randomBytes, createHmac } = require('node:crypto');
const { summarizeGoogleRequest, MAX_STORED_GOOGLE_REQUESTS } = require('./google-request-preview.cjs');

const STORE_DIRECTORY = 'vertex-paygo';
const STORE_FILE = 'usage-ledger.jsonl';

function ledgerPathForUser(user) {
    const root = user?.directories?.root;
    if (typeof root !== 'string' || root.length === 0) return null;
    return path.join(path.resolve(root), STORE_DIRECTORY, STORE_FILE);
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function parseLimit(value) {
    if (value === undefined || value === null || value === '') return 200;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 500 ? parsed : null;
}

function decodeCursor(value) {
    if (value === undefined || value === null || value === '') return { offset: 0, snapshot: undefined };
    try {
        const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
        if (!Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || !Number.isSafeInteger(parsed.snapshot) || parsed.snapshot < 0) return null;
        return parsed;
    } catch { return null; }
}

function encodeCursor(offset, snapshot) {
    return Buffer.from(JSON.stringify({ offset, snapshot })).toString('base64url');
}

/** Confirm fragments against the exact decoded JSON tapped after tier transforms.
 * The receipt is body-free: only opaque IDs/statuses survive this call. */
function summarizeWorldInfoOrder(bytes, plan, epoch, sequence) {
    const base = { version: 1, token: plan.token, epoch, sequence, groups: [] };
    try {
        if (!Buffer.isBuffer(bytes) || bytes.length > 2 * 1024 * 1024) throw new Error();
        const body = JSON.parse(bytes.toString('utf8'));
        if (!body || !Array.isArray(body.contents) || body.contents.length > 512) throw new Error();
        const texts = [];
        const append = content => { if (!content) return; if (!Array.isArray(content.parts)) throw new Error();
            for (const part of content.parts) if (typeof part?.text === 'string') texts.push(part.text);
        };
        append(body.systemInstruction ?? body.system_instruction); body.contents.forEach(append);
        base.groups = plan.groups.map(group => {
            const positions = [];
            let status = 'confirmed';
            for (const item of group.items) {
                let found = null, hits = 0;
                for (let segment = 0; segment < texts.length && hits < 2; segment++) {
                    let offset = texts[segment].indexOf(item.text);
                    while (offset !== -1 && hits < 2) { hits++; found = { segment, offset, end: offset + item.text.length, id: item.id };
                        offset = texts[segment].indexOf(item.text, offset + 1);
                    }
                }
                if (!hits) status = status === 'confirmed' ? 'missing' : status;
                else if (hits > 1) status = 'ambiguous';
                else positions.push(found);
            }
            if (status === 'confirmed' && new Set(positions.map(position => position.segment)).size !== 1) status = 'split';
            positions.sort((left, right) => left.segment - right.segment || left.offset - right.offset);
            if (status === 'confirmed' && positions.some((position, index) => index && position.offset < positions[index - 1].end)) status = 'ambiguous';
            const actual = positions.map(position => position.id);
            if (status === 'confirmed' && JSON.stringify(actual) !== JSON.stringify(group.items.map(item => item.id))) status = 'reordered';
            return { id: group.id, status, items: status === 'confirmed' ? actual : [] };
        });
    } catch { base.groups = plan.groups.map(group => ({ id: group.id, status: 'unavailable', items: [] })); }
    return base;
}

class UsageStore {
    #previewKey;
    #previewEpoch;
    #wireSequences = new Map();
    constructor({ fsModule = fs, now = () => Date.now(), pendingTimeoutMs = 35 * 60_000 } = {}) {
        this.fs = fsModule;
        this.now = now;
        this.pendingTimeoutMs = pendingTimeoutMs;
        this.activeIds = new Set();
        this.recoveredFiles = new Set();
        this.indexes = new Map();
        this.chatIndexes = new Map();
        this.pendingRecords = new Map();
        this.loading = new Map();
        this.readyDirectories = new Set();
        this.#previewKey = randomBytes(32);
        this.#previewEpoch = randomUUID();
    }

    #append(file, record) {
        this.#appendBatch(file, [record]);
    }

    #appendBatch(file, records) {
        const directory = path.dirname(file);
        if (!this.readyDirectories.has(directory)) {
            this.fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            this.readyDirectories.add(directory);
        }
        this.fs.appendFileSync(file, records.map(record => `${JSON.stringify(record)}\n`).join(''), { encoding: 'utf8', mode: 0o600 });
    }

    #index(file, record) {
        let records = this.indexes.get(file);
        if (!records) { records = new Map(); this.indexes.set(file, records); }
        let chats = this.chatIndexes.get(file);
        if (!chats) { chats = new Map(); this.chatIndexes.set(file, chats); }
        let pending = this.pendingRecords.get(file);
        if (!pending) { pending = new Map(); this.pendingRecords.set(file, pending); }
        const previous = records.get(record.id);
        if (previous && previous.chatId !== record.chatId) {
            const oldChat = chats.get(previous.chatId);
            oldChat.records.splice(oldChat.positions.get(record.id), 1);
            oldChat.positions = new Map(oldChat.records.map((value, index) => [value.id, index]));
        }
        let chat = chats.get(record.chatId);
        if (!chat) { chat = { records: [], positions: new Map() }; chats.set(record.chatId, chat); }
        const position = chat.positions.get(record.id) ?? chat.records.length;
        chat.records[position] = record; chat.positions.set(record.id, position);
        records.set(record.id, record);
        if (record.status === 'pending') pending.set(record.id, record);
        else pending.delete(record.id);
    }

    // Production routes await this once per user. Stream large ledgers instead
    // of reading/splitting/parsing the whole file on the host's event loop.
    async ensureLoaded(user) {
        const file = ledgerPathForUser(user);
        if (!file) return;
        if (this.loading.has(file)) return this.loading.get(file);
        if (this.indexes.has(file)) return;
        const task = (async () => {
            const records = new Map();
            try {
                const input = this.fs.createReadStream(file, { encoding: 'utf8' });
                const lines = createInterface({ input, crlfDelay: Infinity });
                let count = 0;
                try {
                    for await (const line of lines) {
                        try { const record = JSON.parse(line); if (record && typeof record.id === 'string') records.set(record.id, record); }
                        catch { /* A partial final JSONL row does not erase earlier usage. */ }
                        if (++count % 1000 === 0) await yieldToServer();
                    }
                } finally { lines.close(); input.destroy(); }
            } catch (error) { if (error?.code !== 'ENOENT') throw error; }
            // Publish only a complete index. Concurrent routes share the load.
            if (this.indexes.has(file)) return;
            this.indexes.set(file, new Map());
            let count = 0;
            for (const record of records.values()) {
                this.#index(file, record);
                if (++count % 1000 === 0) await yieldToServer();
            }
        })();
        this.loading.set(file, task);
        try { await task; } finally { if (this.loading.get(file) === task) this.loading.delete(file); }
    }

    #read(file) {
        const cached = this.indexes.get(file);
        if (cached) return cached;
        let text;
        try { text = this.fs.readFileSync(file, 'utf8'); }
        catch (error) {
            if (error?.code === 'ENOENT') {
                this.indexes.set(file, new Map());
                return this.indexes.get(file);
            }
            throw error;
        }
        const records = new Map();
        for (const line of text.split('\n')) {
            if (!line) continue;
            try {
                const record = JSON.parse(line);
                if (record && typeof record.id === 'string') records.set(record.id, record);
            } catch {                                                                 }
        }
        for (const record of records.values()) this.#index(file, record);
        if (!this.indexes.has(file)) this.indexes.set(file, new Map());
        return this.indexes.get(file);
    }

    #recover(file) {
        this.#read(file);
        const firstAccess = !this.recoveredFiles.has(file);
        const cutoff = this.now() - this.pendingTimeoutMs;
        let batch = [];
        const flush = () => {
            if (!batch.length) return;
            this.#appendBatch(file, batch);
            for (const record of batch) { this.#index(file, record); this.activeIds.delete(record.id); }
            batch = [];
        };
        for (const record of this.pendingRecords.get(file)?.values() ?? []) {
            if (record.status === 'pending' && (firstAccess && !this.activeIds.has(record.id)
                || this.activeIds.has(record.id) && Date.parse(record.createdAt) <= cutoff)) {
                const timedOut = this.activeIds.has(record.id);
                const recovered = { ...record, status: 'incomplete', errorCode: timedOut ? 'USAGE_CAPTURE_TIMEOUT' : 'PROCESS_RESTARTED' };
                batch.push(recovered);
                if (batch.length >= 1000) flush();
            }
        }
        flush(); this.recoveredFiles.add(file);
    }

    create(user, details) {
        const file = ledgerPathForUser(user);
        if (!file || !details.chatId) return null;
        this.#recover(file);
        const record = {
            id: randomUUID(), chatId: details.chatId, createdAt: new Date(this.now()).toISOString(),
            model: details.model, source: details.source, tier: details.tier, region: details.region,
            stream: details.stream, status: 'pending', usage: null, price: clone(details.price),
        };
        this.#append(file, record);
        this.#index(file, record);
        this.activeIds.add(record.id);
        return { file, id: record.id, record: clone(record) };
    }

    update(reference, patch) {
        if (!reference?.file || !reference?.id) return;
        this.#recover(reference.file);
        const record = this.indexes.get(reference.file)?.get(reference.id);
        if (!record || record.status !== 'pending' || !this.activeIds.has(record.id)) return;
        const updated = { ...record };
        if (patch.usage !== undefined) updated.usage = clone(patch.usage);
        if (patch.status) updated.status = patch.status;
        if (patch.errorCode) updated.errorCode = patch.errorCode;
        else if (patch.status === 'complete') delete updated.errorCode;
        this.#append(reference.file, updated);
        this.#index(reference.file, updated);
        if (updated.status !== 'pending') this.activeIds.delete(updated.id);
    }

    captureGoogleRequest(reference, bytes, options, worldInfoOrder) {
        if (!reference?.file || !reference?.id) return;
        const record = this.#read(reference.file).get(reference.id);
        if (!record) return;
        // Per-process, per-user keyed digests cannot be used as public prompt
        // hashes. Only projections are persisted; raw bytes never leave here.
        const summary = summarizeGoogleRequest(bytes, { ...options, epoch: this.#previewEpoch,
            fingerprint: value => createHmac('sha256', this.#previewKey).update(reference.file).update('\0').update(value).digest('hex') });
        if (worldInfoOrder) {
            const sequence = (this.#wireSequences.get(reference.file) ?? 0) + 1;
            this.#wireSequences.set(reference.file, sequence);
            summary.worldInfoOrder = summarizeWorldInfoOrder(bytes, worldInfoOrder, this.#previewEpoch, sequence);
        }
        const previews = Array.isArray(record.googleRequests) ? record.googleRequests.slice(0, MAX_STORED_GOOGLE_REQUESTS) : [];
        if (previews.length < MAX_STORED_GOOGLE_REQUESTS) previews.push(summary);
        else if (summary.worldInfoOrder && previews.length) {
            // Keep the first wire projections, but do not lose the latest
            // verification when native continuations exceed the preview cap.
            previews[0] = { ...previews[0], latestWorldInfoOrder: summary.worldInfoOrder };
        }
        const updated = { ...record, googleRequests: previews, googleRequestCount: (Number.isSafeInteger(record.googleRequestCount) && record.googleRequestCount >= 0 ? record.googleRequestCount : 0) + 1 };
        // A fast upstream can complete before a request tap flushes. Preserve
        // terminal usage/status rather than reviving or overwriting the record.
        this.#append(reference.file, updated);
        this.#index(reference.file, updated);
    }

    listLatest(user, chatId, limit = 12) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) return null;
        const file = ledgerPathForUser(user);
        if (!file) return null;
        this.#recover(file);
        const records = (this.chatIndexes.get(file)?.get(chatId)?.records ?? []).slice(-limit);
        return { records: clone(records) };
    }

    listByIds(user, chatId, ids, { includeRequestPreviews = false } = {}) {
        const file = ledgerPathForUser(user);
        if (!file) return null;
        this.#recover(file);
        const index = this.indexes.get(file), records = [];
        for (const id of ids) {
            const record = index.get(id);
            if (!record || record.chatId !== chatId) continue;
            if (includeRequestPreviews) records.push(record);
            else { const { googleRequests, googleRequestCount, ...costRecord } = record; records.push(costRecord); }
        }
        return { records: clone(records), lookup: true };
    }

    list(user, chatId, options = undefined) {
        const file = ledgerPathForUser(user);
        if (!file) return null;
        this.#recover(file);
        const all = this.chatIndexes.get(file)?.get(chatId)?.records ?? [];
        if (options === undefined) return clone(all);
        const { cursor, limit } = options;
        const pageSize = parseLimit(limit);
        const position = decodeCursor(cursor);
        if (pageSize === null || !position) return null;
        const snapshot = position.snapshot === undefined ? all.length : Math.min(position.snapshot, all.length);
        const page = all.slice(position.offset, Math.min(position.offset + pageSize, snapshot));
        const nextOffset = position.offset + page.length;
        const truncated = nextOffset < snapshot;
        return {
            records: clone(options.includeRequestPreviews === false ? page.map(record => {
                const { googleRequests, googleRequestCount, ...costRecord } = record; return costRecord;
            }) : page),
            ...(truncated ? { nextCursor: encodeCursor(nextOffset, snapshot), truncated: true } : {}),
        };
    }
}

module.exports = { STORE_DIRECTORY, STORE_FILE, UsageStore, ledgerPathForUser, summarizeWorldInfoOrder };
