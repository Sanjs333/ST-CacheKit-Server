/* Bounded final outbound evidence with per-user rolling request history.
 * SPDX-License-Identifier: MPL-2.0. */
'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { PluginError } = require('./errors.cjs');
const { validateChatId } = require('./protocol.cjs');
const { PromptInspectorArchive, HISTORY_LIMIT } = require('./prompt-inspector-archive.cjs');
const PROMPT_INSPECTOR_WIRE_HOOK = Symbol.for('vertex-paygo.prompt-inspector.wire.v1');
const PROMPT_INSPECTOR_WIRE_CAPABILITY = Symbol.for('vertex-paygo.prompt-inspector.wire-capability.v1');
const FIELD = '__vertexPayGoPromptInspector';
const SOURCES = new Set(['vertexai', 'makersuite', 'custom', 'openai', 'claude']);
const NATIVE = new Set(['custom', 'openai', 'claude']);
const GOOGLE = new Set(['vertexai', 'makersuite']);
const BOUNDARY_STATUSES = new Set(['waiting', 'disabled', 'source-unavailable', 'source-ready', 'ambiguous', 'unsupported',
    'bound', 'unavailable', 'submitted', 'split', 'already-separated']);
const KINDS = new Set(['preset', 'character', 'persona', 'worldinfo-blue', 'worldinfo-green', 'worldinfo-depth', 'worldinfo-other', 'author-note', 'memory', 'extension', 'history', 'input', 'unknown']);
const ERROR_CODES = new Set(['NATIVE_SEND_FAILED', 'NATIVE_FETCH_FAILED', 'NATIVE_GENERATION_FAILED', 'UPSTREAM_HTTP_ERROR', 'OUTBOUND_REQUEST_FAILED', 'FINAL_SCOPE_MISMATCH', 'RAW_BODY_UNAVAILABLE', 'INVALID_UTF8', 'BODY_TOO_LARGE', 'INSPECTOR_CAPACITY', 'CLIENT_DISCONNECTED', 'VERTEX_UPSTREAM_FAILED', 'VERTEX_UPSTREAM_TIMEOUT', 'VERTEX_REDIRECT_REJECTED', 'PROXY_REQUEST_STREAM_FAILED', 'UPSTREAM_RESPONSE_STREAM_FAILED', 'REQUEST_BODY_TOO_LARGE', 'INVALID_GOOGLE_BODY', 'PREPARE_FAILED', 'GEMINI4_UPSTREAM_HTTP_ERROR', 'GEMINI4_UPSTREAM_ERROR', 'GEMINI4_INCOMPLETE_RESPONSE', 'GEMINI4_RESPONSE_TOO_LARGE', 'GEMINI4_CONTINUATION_LIMIT', 'GEMINI4_CONTINUATION_LOOP']);
function safeError(code, fallback = 'OUTBOUND_REQUEST_FAILED') {
    return typeof code === 'string' && (ERROR_CODES.has(code) || /^NATIVE_RELAY_(?:UPSTREAM_FAILED|UPSTREAM_TIMEOUT|REDIRECT_REJECTED|REQUEST_FAILED|RESPONSE_FAILED)$/u.test(code) || /^UPSTREAM_HTTP_[1-5][0-9]{2}$/u.test(code)) ? code : fallback;
}
function owner(request) {
    const user = request?.user, profile = user?.profile, root = user?.directories?.root;
    const identity = [profile?.handle, profile?.username, profile?.id].find(v => typeof v === 'string' && v.length > 0 && v.length <= 256);
    if (!identity || typeof root !== 'string' || !root || root.length > 32_768) return null;
    // Both profile AND data root participate. No shared anonymous bucket.
    return createHash('sha256').update(JSON.stringify([identity, root])).digest('hex');
}
function modelId(value) {
    if (typeof value !== 'string' || !value || value.length > 256 || value.trim() !== value || /[\x00-\x1f\x7f]/u.test(value)) throw new PluginError(400, 'INVALID_PROMPT_INSPECTOR_SCOPE', '提示词查看器的模型参数无效。');
    return value;
}
function emptyTrace() { return { version: 1, complete: false, sources: [], stages: [], events: [] }; }
// No toJSON/getters/prototype setters. Bound depth, nodes and bytes BEFORE copying.
function boundedClone(value, maxBytes) {
    let bytes = 0, nodes = 0;
    const charge = n => { bytes += n; if (bytes > maxBytes) throw new RangeError('Bounded evidence exceeded.'); };
    const copy = (v, depth) => {
        if (++nodes > 20_000 || depth > 24) throw new RangeError('Bounded evidence exceeded.');
        if (typeof v === 'string') { charge(Buffer.byteLength(v) + 2); return v; }
        if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) { charge(24); return v; }
        if (!v || typeof v !== 'object') throw new TypeError('Invalid evidence.');
        charge(2);
        if (Array.isArray(v)) {
            if (v.length > 4096) throw new RangeError('Bounded evidence exceeded.');
            const result = [];
            for (let i = 0; i < v.length; i++) { const d = Object.getOwnPropertyDescriptor(v, String(i)); if (!d || !('value' in d)) throw new TypeError('Invalid evidence.'); result.push(copy(d.value, depth + 1)); }
            return result;
        }
        const keys = Object.keys(v);
        if (keys.length > 256) throw new RangeError('Bounded evidence exceeded.');
        const result = {};
        for (const key of keys) {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new TypeError('Invalid evidence.');
            charge(Buffer.byteLength(key) + 4);
            const d = Object.getOwnPropertyDescriptor(v, key);
            if (!d || !('value' in d)) throw new TypeError('Invalid evidence.');
            result[key] = copy(d.value, depth + 1);
        }
        return result;
    };
    const result = copy(value, 0);
    if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new RangeError('Bounded evidence exceeded.');
    return result;
}
function normalizeTrace(input, limit) {
    try {
        if (input == null) return { trace: emptyTrace() };
        const data = boundedClone(input, limit);
        if (data.version !== 1 || typeof data.complete !== 'boolean' || !Array.isArray(data.sources) || !Array.isArray(data.stages) || !Array.isArray(data.events)) throw new TypeError('Invalid trace.');
        if (data.sources.length > 256 || data.stages.length > 16 || data.events.length > 256) throw new RangeError('Bounded trace exceeded.');
        const sources = data.sources.map(source => {
            if (!source || typeof source.id !== 'string' || typeof source.label !== 'string' || typeof source.text !== 'string') throw new TypeError('请求来源无效。');
            const result = { id: source.id, kind: KINDS.has(source.kind) ? source.kind : 'unknown', label: source.label, text: source.text };
            for (const key of ['world', 'uid', 'constant', 'position', 'depth', 'role', 'identifier']) if (source[key] !== undefined && (typeof source[key] === 'string' || typeof source[key] === 'boolean' || typeof source[key] === 'number')) result[key] = source[key];
            if (typeof source.originalText === 'string') result.originalText = source.originalText;
            if (typeof source.outletName === 'string') result.outletName = source.outletName;
            if (typeof source.priority === 'string' || (typeof source.priority === 'number' && Number.isFinite(source.priority))) result.priority = source.priority;
            if (source.aggregate === true) {
                result.aggregate = true;
                if (Array.isArray(source.inputs)) {
                    if (source.inputs.length > 128) throw new RangeError('Bounded source inputs exceeded.');
                    result.inputs = source.inputs.filter(input => input && typeof input.id === 'string'
                        && input.id.length <= 512 && typeof input.label === 'string' && input.label.length <= 512
                        && ['prompt', 'extension-prompt'].includes(input.kind))
                        .map(input => ({ id: input.id, label: input.label, kind: input.kind }));
                }
            }
            return result;
        });
        const stages = data.stages.filter(stage => stage?.id !== 'backend-final').map(stage => {
            if (!stage || typeof stage.id !== 'string' || typeof stage.label !== 'string' || !Array.isArray(stage.messages)) throw new TypeError('Invalid stage.');
            return { id: stage.id, label: stage.label, messages: stage.messages, ...(Array.isArray(stage.notes) ? { notes: stage.notes.filter(n => typeof n === 'string') } : {}) };
        });
        const events = data.events.filter(event => event?.evidence === 'observed').map(event => {
            if (typeof event.kind !== 'string' || typeof event.label !== 'string') throw new TypeError('Invalid event.');
            const result = { kind: event.kind, label: event.label, evidence: 'observed' };
            for (const key of ['sourceIds', 'before', 'after']) if (event[key] !== undefined) result[key] = event[key];
            return result;
        });
        return { trace: { version: 1, complete: data.complete, sources, stages, events, ...(typeof data.reason === 'string' ? { reason: data.reason } : {}) } };
    } catch (error) { return { trace: { ...emptyTrace(), reason: error instanceof RangeError ? 'TRACE_LIMIT' : 'TRACE_INVALID' }, traceError: error instanceof RangeError ? 'TRACE_TOO_LARGE' : 'TRACE_INVALID' }; }
}
function metadataSafe(input) {
    const result = {};
    if (!input || typeof input !== 'object') return result;
    const get = key => { try { const d = Object.getOwnPropertyDescriptor(input, key); return d && 'value' in d ? d.value : undefined; } catch { return undefined; } };
    const transport = get('transport'), tier = get('tier'), region = get('region'), stream = get('stream'), httpStatus = get('httpStatus') ?? get('status'), bodyBytes = get('bodyBytes');
    if (['native', 'native-loopback-http', 'google-proxy', 'google-gemini4'].includes(transport)) result.transport = transport;
    if (['standard', 'flex'].includes(tier)) result.tier = tier;
    if (typeof region === 'string' && /^[a-z0-9-]{1,63}$/u.test(region)) result.region = region;
    if (typeof stream === 'boolean') result.stream = stream;
    if (Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) result.httpStatus = httpStatus;
    if (Number.isSafeInteger(bodyBytes) && bodyBytes >= 0) result.bodyBytes = bodyBytes;
    if (get('cacheWarm') === true) result.cacheWarm = true;
    const boundaryStatus = get('cacheBoundaryStatus'), stableChars = get('cacheBoundaryStableTextChars');
    if (BOUNDARY_STATUSES.has(boundaryStatus)) result.cacheBoundaryStatus = boundaryStatus;
    if (Number.isSafeInteger(stableChars) && stableChars >= 0 && stableChars <= 2 * 1024 * 1024) result.cacheBoundaryStableTextChars = stableChars;
    return result;
}
function finalStage(raw, source, limit) {
    const body = JSON.parse(raw);
    let messages = [], notes = [];
    if (GOOGLE.has(source)) {
        if (body.systemInstruction !== undefined) messages.push(body.systemInstruction);
        if (Array.isArray(body.contents)) messages.push(...body.contents);
        notes = ['Exact Google systemInstruction (when present), followed by contents. Other request fields remain in rawRequest.'];
    } else {
        if (source === 'claude' && body.system !== undefined) messages.push({ system: body.system });
        if (body.instructions !== undefined) messages.push({ instructions: body.instructions });
        if (Array.isArray(body.messages)) messages.push(...body.messages);
        for (const key of ['prompt', 'input']) if (body[key] !== undefined) messages.push({ [key]: body[key] });
        notes = ['Exact native prompt-bearing fields and message objects. Fields without message roles remain field objects; other request fields remain in rawRequest.'];
    }
    return boundedClone({ id: 'backend-final', label: 'Final outbound request', messages, notes }, limit);
}
class PromptInspectorStore {
    constructor({ now = Date.now, ttlMs = 300_000, maxEntries = 128, maxEntriesPerOwner = 16, maxBodyBytes = 2 * 1024 * 1024,
        maxTraceBytes = 1024 * 1024, maxTotalBytes = 16 * 1024 * 1024, maxTombstones = 128, idFactory = randomUUID,
        getCapability = () => false, maxHistoryEntries = HISTORY_LIMIT } = {}) {
        for (const n of [ttlMs, maxEntries, maxEntriesPerOwner, maxBodyBytes, maxTraceBytes, maxTotalBytes, maxTombstones]) if (!Number.isSafeInteger(n) || n < 1) throw new TypeError('Invalid prompt inspector limits.');
        if (!Number.isSafeInteger(maxHistoryEntries) || maxHistoryEntries < 1 || maxHistoryEntries > HISTORY_LIMIT) throw new TypeError('Invalid request history limit.');
        Object.assign(this, { now, ttlMs, maxEntries, maxEntriesPerOwner, maxBodyBytes, maxTraceBytes, maxTotalBytes, maxTombstones, idFactory, getCapability, maxHistoryEntries });
        this.entries = new Map(); this.latest = new Map(); this.tombstones = new Map(); this.sequence = 0; this.usedBytes = 0; this.bufferedBytes = 0; this.closed = false;
        this.archives = new Map();
        this.requests = new WeakMap(); this.references = new WeakMap(); this.dispatches = new WeakMap();
        this.hook = Object.freeze({ claim: request => this.quiet(() => this.claim(request)), beforeSend: (request, raw, meta) => this.quiet(() => this.beforeSend(request, raw, meta)),
            sent: (request, raw, meta) => this.quiet(() => this.sent(request, raw, meta)), failed: (request, code) => this.quiet(() => this.failed(request, code)) });
        this.timer = setInterval(() => this.quiet(() => this.sweep()), Math.min(ttlMs, 10_000)); this.timer.unref?.();
    }
    quiet(fn) { try { return fn(); } catch { return null; } }
    archiveFor(request, owned = owner(request)) {
        if (!owned) return null;
        let archive = this.archives.get(owned);
        if (!archive) {
            archive = new PromptInspectorArchive({ rootDir: request.user.directories.root, owner: owned,
                maxEntries: this.maxHistoryEntries, maxRecordBytes: this.maxBodyBytes * 3 + this.maxTraceBytes + 64 * 1024 });
            this.archives.set(owned, archive);
            while (this.archives.size > 64) this.archives.delete(this.archives.keys().next().value);
        }
        return archive;
    }
    persist(entry) {
        if (!entry?.archive || !entry.record?.sequence) return false;
        try {
            delete entry.record.metadata.archiveError;
            entry.record.metadata.archiveStatus = 'saved';
            if (!entry.archive.save(entry.record)) throw new Error('Request history unavailable.');
            return true;
        } catch { entry.record.metadata.archiveStatus = 'failed'; entry.record.metadata.archiveError = 'ARCHIVE_WRITE_FAILED'; return false; }
    }
    makeRoom(bytes = 0, owned = null, exclude = null) {
        const over = () => this.entries.size >= this.maxEntries
            || owned && [...this.entries.values()].filter(entry => entry.owner === owned).length >= this.maxEntriesPerOwner
            || this.usedBytes + this.bufferedBytes + bytes > this.maxTotalBytes;
        for (const [id, entry] of this.entries) {
            if (!over()) break;
            if (id !== exclude && entry.record?.sequence > 0 && !entry.busy && !entry.cleanups.size) this.drop(id, 'archived');
        }
        return !over();
    }
    capabilities() {
        const available = !this.closed;
        const nativeRelay = available && this.quiet(() => this.getCapability()) === true;
        const pluginWireSources = available ? [...GOOGLE, ...(nativeRelay ? [...NATIVE] : [])] : [];
        return { version: 1, available, api: available, nativeWire: nativeRelay, nativeRelay, googleWire: available,
            // Plugin-owned transports observe the final serialized provider
            // body without registering observers in the host's source code.
            requiresHostPatch: false,
            pluginWireSources,
            supportedSources: [...pluginWireSources],
            sourceTrace: 'frontend-supplied', privacyMode: 'user-data',
            limits: { ttlMs: this.ttlMs, maxBodyBytes: this.maxBodyBytes, maxTraceBytes: this.maxTraceBytes,
                maxTotalBytes: this.maxTotalBytes, maxEntries: this.maxEntries, maxEntriesPerOwner: this.maxEntriesPerOwner,
                maxHistoryEntries: this.maxHistoryEntries } };
    }
    scope(entry) { return JSON.stringify([entry.owner, entry.chatId, entry.source, entry.model]); }
    sweep() {
        const now = this.now();
        for (const [id, entry] of this.entries) if (entry.record?.sequence === 0 && now >= entry.expires) this.drop(id, 'expired');
        for (const [id, tombstone] of this.tombstones) if (now >= tombstone.until) this.tombstones.delete(id);
    }
    drop(id, status = 'unknown') {
        const entry = this.entries.get(id); if (!entry) return;
        this.entries.delete(id);
        if (this.latest.get(this.scope(entry)) === id) this.latest.delete(this.scope(entry));
        for (const cleanup of entry.cleanups) this.quiet(cleanup);
        entry.cleanups.clear();
        this.usedBytes -= entry.bytes;
        const sequence = entry.record?.sequence ?? 0;
        if (status !== 'cleared') this.persist(entry);
        // In-flight references contain only IDs. Also wipe the entry for any external reference.
        entry.record = null; entry.bytes = 0;
        this.tombstones.set(id, { owner: entry.owner, chatId: entry.chatId, source: entry.source, model: entry.model, sequence, status, until: this.now() + this.ttlMs });
        while (this.tombstones.size > this.maxTombstones) this.tombstones.delete(this.tombstones.keys().next().value);
    }
    prepare(request) {
        this.sweep(); const owned = owner(request);
        if (!owned) throw new PluginError(401, 'AUTHENTICATED_USER_REQUIRED', '请先登录用户账号，并确认用户数据目录可用。');
        if (this.closed) throw new PluginError(503, 'PROMPT_INSPECTOR_UNAVAILABLE', '提示词查看器暂不可用。');
        const data = request.body;
        if (!data || data.version !== 1 || !SOURCES.has(data.source)) throw new PluginError(400, 'INVALID_PROMPT_INSPECTOR_SCOPE', '提示词查看器的记录范围或版本无效。');
        if (NATIVE.has(data.source) && this.quiet(() => this.getCapability()) !== true) {
            throw new PluginError(503, 'NATIVE_PROMPT_CAPTURE_UNAVAILABLE',
                '当前服务商不支持捕获最终出站请求，可查看前端组装的消息。');
        }
        const chatId = validateChatId(data.chatId), model = modelId(data.model);
        this.makeRoom(0, owned);
        if (this.entries.size >= this.maxEntries || [...this.entries.values()].filter(e => e.owner === owned).length >= this.maxEntriesPerOwner) throw new PluginError(429, 'PROMPT_INSPECTOR_CAPACITY', '提示词临时记录已达到容量上限，请清理记录后重试。');
        let { trace, traceError } = normalizeTrace(data.trace, this.maxTraceBytes);
        let bytes = Buffer.byteLength(JSON.stringify(trace)) + 1024;
        this.makeRoom(bytes, owned);
        if (this.usedBytes + this.bufferedBytes + bytes > this.maxTotalBytes) { trace = { ...emptyTrace(), reason: 'TRACE_LIMIT' }; traceError = 'TRACE_CAPACITY'; bytes = Buffer.byteLength(JSON.stringify(trace)) + 1024; }
        if (this.usedBytes + this.bufferedBytes + bytes > this.maxTotalBytes) throw new PluginError(429, 'PROMPT_INSPECTOR_CAPACITY', '提示词临时记录已达到容量上限，请清理记录后重试。');
        const ticket = this.idFactory();
        if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(ticket) || this.entries.has(ticket) || this.tombstones.has(ticket)) throw new PluginError(503, 'PROMPT_INSPECTOR_UNAVAILABLE', '提示词查看凭证签发失败。');
        const expires = this.now() + this.ttlMs;
        const record = { version: 1, id: ticket, chatId, source: data.source, model, sequence: 0, capturedAt: new Date(this.now()).toISOString(),
            state: 'pending', complete: false, rawRequest: null, trace, metadata: traceError ? { traceError } : {} };
        const archive = this.archiveFor(request, owned);
        this.sequence = Math.max(this.sequence, this.quiet(() => archive.maxSequence()) ?? 0);
        this.entries.set(ticket, { owner: owned, chatId, source: data.source, model, expires, bytes, record, archive, busy: false, bound: false, cleanups: new Set() });
        this.usedBytes += bytes;
        return { version: 1, ticket, expiresAt: new Date(expires).toISOString() };
    }
    matchQuery(entry, query) { return (query.chatId === undefined || query.chatId === entry.chatId) && (query.source === undefined || query.source === entry.source) && (query.model === undefined || query.model === entry.model); }
    read(request, remove = false) {
        this.sweep(); const owned = owner(request), query = request.query || {};
        if (!owned) throw new PluginError(401, 'AUTHENTICATED_USER_REQUIRED', '请先登录用户账号，并确认用户数据目录可用。');
        if (query.ticket !== undefined && (typeof query.ticket !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(query.ticket))) throw new PluginError(400, 'INVALID_PROMPT_INSPECTOR_QUERY', '提示词查看凭证无效。');
        if (query.chatId !== undefined) validateChatId(query.chatId);
        if (query.source !== undefined && !SOURCES.has(query.source)) throw new PluginError(400, 'INVALID_PROMPT_INSPECTOR_QUERY', '请求来源无效。');
        if (query.model !== undefined) modelId(query.model);
        const history = query.history === true || query.history === 'true';
        const pendingOnly = query.pendingOnly === true || query.pendingOnly === 'true';
        if (query.history !== undefined && ![true, false, 'true', 'false'].includes(query.history)
            || query.pendingOnly !== undefined && ![true, false, 'true', 'false'].includes(query.pendingOnly)) throw new PluginError(400, 'INVALID_PROMPT_INSPECTOR_QUERY', '提示词记录筛选无效。');
        if (query.ticket === undefined && query.chatId === undefined && !history) throw new PluginError(400, 'INVALID_PROMPT_INSPECTOR_QUERY', '请求必须包含查看凭证或对话 ID。');
        const archive = this.archiveFor(request, owned);
        let selected;
        if (query.ticket !== undefined) {
            for (const [id, e] of this.entries) if ((id === query.ticket || e.record?.id === query.ticket)
                && e.owner === owned && this.matchQuery(e, query)) { selected = [id, e]; break; }
        } else {
            for (const [id, e] of this.entries) if (e.owner === owned && this.matchQuery(e, query) && e.record.sequence > 0 && (!selected || e.record.sequence > selected[1].record.sequence)) selected = [id, e];
        }
        if (remove) {
            const deletedRecordIds = [];
            for (const [id, e] of this.entries) if (e.owner === owned && this.matchQuery(e, query)
                && (query.ticket === undefined || query.ticket === id || query.ticket === e.record?.id)
                && (!pendingOnly || e.record?.sequence === 0)) { deletedRecordIds.push(e.record?.id); this.drop(id, 'cleared'); }
            if (!pendingOnly) {
                archive.remove(query);
                for (const id of deletedRecordIds) if (id && id !== query.ticket) archive.remove({ ticket: id });
            }
            return { version: 1, snapshot: null, status: 'cleared' };
        }
        if (history) {
            const records = new Map(archive.list(query).map(record => [record.id, record]));
            for (const [id, e] of this.entries) if (e.owner === owned && this.matchQuery(e, query) && e.record.sequence > 0
                && (query.ticket === undefined || query.ticket === id || query.ticket === e.record.id)) {
                const record = e.record;
                records.set(record.id, Object.fromEntries(['id', 'chatId', 'source', 'model', 'sequence', 'state', 'complete',
                    'capturedAt', 'dispatchAt', 'responseAt', 'errorCode', 'metadata'].filter(key => record[key] !== undefined)
                    .map(key => [key, structuredClone(record[key])])));
            }
            return { version: 1, status: 'history', history: [...records.values()].sort((a, b) => b.sequence - a.sequence).slice(0, this.maxHistoryEntries), limit: this.maxHistoryEntries };
        }
        const archived = archive.read(query);
        if (selected && (!archived || selected[1].record.sequence >= archived.sequence)) return { version: 1, snapshot: structuredClone(selected[1].record), status: selected[1].record.state };
        if (archived) return { version: 1, snapshot: archived, status: archived.state };
        let t = this.tombstones.get(query.ticket);
        if (query.ticket === undefined) for (const candidate of this.tombstones.values()) if (candidate.owner === owned && this.matchQuery(candidate, query) && candidate.sequence > 0 && (!t || candidate.sequence > t.sequence)) t = candidate;
        return { version: 1, snapshot: null, status: t?.owner === owned && this.matchQuery(t, query) ? t.status : 'unknown' };
    }
    bind(id, owned, chatId, source, model) {
        this.sweep(); const entry = this.entries.get(id);
        if (this.closed || !owned || !entry || entry.bound || entry.owner !== owned || entry.chatId !== chatId || entry.source !== source || entry.model !== model) return null;
        entry.bound = true;
        const reference = Object.freeze({});
        this.references.set(reference, { id, owner: owned, chatId, source, model });
        return reference;
    }
    claim(request) {
        // Strip BEFORE any validation, even malformed, disabled or unknown tickets.
        const data = request?.body;
        const descriptor = data && typeof data === 'object' ? Object.getOwnPropertyDescriptor(data, FIELD) : null;
        if (data && typeof data === 'object') delete data[FIELD];
        const field = descriptor && 'value' in descriptor ? descriptor.value : null;
        if (!field || typeof field !== 'object' || Array.isArray(field) || field.version !== 1 || typeof field.ticket !== 'string' || typeof field.chatId !== 'string' || !NATIVE.has(data.chat_completion_source)) return null;
        if (this.requests.has(request)) return null;
        const reference = this.bind(field.ticket, owner(request), field.chatId, data.chat_completion_source, data.model);
        if (reference) this.requests.set(request, { reference, chatId: field.chatId, handle: null, terminal: false });
        return reference;
    }
    nativeClaim(request) {
        const claim = this.requests.get(request); if (!claim) return null;
        const context = this.references.get(claim.reference);
        if (!context || owner(request) !== context.owner || request.body?.chat_completion_source !== context.source || request.body?.model !== context.model
            || (request.body.chatId !== undefined && request.body.chatId !== context.chatId) || (request.body.usageChatId !== undefined && request.body.usageChatId !== context.chatId)) return null;
        return claim;
    }
    beforeSend(request, raw, metadata) {
        const claim = this.nativeClaim(request); if (!claim || claim.handle || claim.terminal) return null;
        claim.handle = this.beginGoogleDispatch(claim.reference, { ...metadataSafe(metadata), transport: 'native' });
        this.captureGoogleBody(claim.handle, raw, undefined, metadata);
        return claim.handle;
    }
    sent(request, raw, metadata) {
        const claim = this.nativeClaim(request); if (!claim) return null;
        // Never reconstruct at response time or stamp a late response as a dispatch.
        if (claim.terminal) return null;
        claim.terminal = true;
        if (!claim.handle) return this.failGoogleTicket(claim.reference, 'RAW_BODY_UNAVAILABLE');
        return this.finishGoogleDispatch(claim.handle, undefined, metadata);
    }
    failed(request, code) {
        const claim = this.nativeClaim(request); if (!claim) return null;
        if (claim.terminal) {
            // sent() observes fetch headers; a later response stream failure is
            // still real failure, but can never restamp or resurrect evidence.
            const entry = claim.handle ? this.active(claim.handle) : null;
            if (entry?.record.state === 'responded') { entry.record.state = 'failed'; entry.record.errorCode = safeError(code, 'NATIVE_SEND_FAILED'); entry.record.responseAt = new Date(this.now()).toISOString(); this.persist(entry); }
            else if (!entry && !this.closed && claim.handle) {
                const dispatch = this.dispatches.get(claim.handle);
                const saved = dispatch?.archive ? this.quiet(() => dispatch.archive.read({ ticket: dispatch.recordId })) : null;
                if (saved?.state === 'responded' && saved.sequence === dispatch.sequence) {
                    saved.state = 'failed'; saved.errorCode = safeError(code, 'NATIVE_SEND_FAILED'); saved.responseAt = new Date(this.now()).toISOString();
                    this.quiet(() => dispatch.archive.save(saved));
                }
            }
            return null;
        }
        claim.terminal = true;
        if (claim.handle) return this.finishGoogleDispatch(claim.handle, safeError(code, 'NATIVE_SEND_FAILED'));
        const context = this.references.get(claim.reference), entry = this.entries.get(context?.id);
        if (!entry) return null;
        entry.record.state = 'failed'; entry.record.errorCode = safeError(code, 'NATIVE_SEND_FAILED'); entry.record.responseAt = new Date(this.now()).toISOString();
    }
    bindGoogleTicket(request, config) { return this.quiet(() => GOOGLE.has(config?.source) ? this.bind(config.promptInspectorTicket, owner(request), config.usageChatId, config.source, config.model) : null); }
    bindNativeTicket(request, config) { return this.quiet(() => NATIVE.has(config?.source) ? this.bind(config.promptInspectorTicket, owner(request), config.chatId, config.source, config.model) : null); }
    nativeScopeMatches(reference, request, config) { return this.quiet(() => {
        this.sweep(); const context = this.references.get(reference), entry = this.entries.get(context?.id);
        return !this.closed && !!entry && owner(request) === context.owner && config?.source === context.source && config?.model === context.model && config?.chatId === context.chatId;
    }); }
    googleScopeMatches(reference, request, config) { return this.quiet(() => {
        this.sweep(); const context = this.references.get(reference), entry = this.entries.get(context?.id);
        return !this.closed && !!entry && owner(request) === context.owner && config?.source === context.source && config?.model === context.model && config?.usageChatId === context.chatId;
    }); }
    active(handle) {
        this.sweep(); const context = this.dispatches.get(handle), entry = this.entries.get(context?.id);
        return !this.closed && entry && entry.owner === context.owner && entry.record.sequence === context.sequence ? entry : null;
    }
    beginGoogleDispatch(reference, metadata) { return this.quiet(() => {
        this.sweep(); const context = this.references.get(reference), entry = this.entries.get(context?.id);
        if (this.closed || !entry || entry.owner !== context.owner) return null;
        // Tickets remain request-bound; each actual dispatch gets a distinct
        // persisted ID so a continuation cannot overwrite an earlier body.
        const previous = this.latest.get(this.scope(entry));
        const previousEntry = this.entries.get(previous);
        if (previous && previous !== context.id && !previousEntry?.busy) this.drop(previous, 'archived');
        for (const cleanup of entry.cleanups) this.quiet(cleanup); entry.cleanups.clear();
        const record = entry.record;
        this.persist(entry);
        this.usedBytes -= entry.bytes;
        record.rawRequest = null; record.complete = false;
        record.trace.stages = record.trace.stages.filter(stage => stage.id !== 'backend-final');
        record.id = randomUUID(); record.sequence = ++this.sequence; record.capturedAt = new Date(this.now()).toISOString(); record.state = 'dispatched'; delete record.responseAt; delete record.errorCode;
        record.metadata = { ...(record.metadata.traceError ? { traceError: record.metadata.traceError } : {}), ...metadataSafe(metadata) };
        entry.bytes = Buffer.byteLength(JSON.stringify(record.trace)) + 1024; this.usedBytes += entry.bytes;
        entry.busy = true; entry.expires = Infinity;
        this.latest.set(this.scope(entry), context.id);
        const handle = Object.freeze({}); this.dispatches.set(handle, { ...context, sequence: record.sequence, recordId: record.id,
            archive: entry.archive, captured: false, terminal: false }); return handle;
    }); }
    captureGoogleBody(handle, rawBody, info, metadata) { return this.quiet(() => {
        const entry = this.active(handle), context = this.dispatches.get(handle);
        if (!entry || context.captured) return null;
        context.captured = true;
        const record = entry.record;
        Object.assign(record.metadata, metadataSafe(metadata));
        const size = typeof rawBody === 'string' ? Buffer.byteLength(rawBody) : Buffer.isBuffer(rawBody) || rawBody instanceof Uint8Array ? rawBody.byteLength : info?.bodyBytes;
        Object.assign(record.metadata, metadataSafe({ bodyBytes: size }));
        if ((Number.isSafeInteger(size) && size > this.maxBodyBytes) || info?.reason === 'BODY_TOO_LARGE' || info?.reason === 'INSPECTOR_CAPACITY') {
            record.state = 'oversize'; record.errorCode = info?.reason === 'INSPECTOR_CAPACITY' ? 'INSPECTOR_CAPACITY' : 'BODY_TOO_LARGE'; this.persist(entry); return;
        }
        let raw;
        try {
            if (typeof rawBody === 'string') { if (Buffer.from(rawBody).toString('utf8') !== rawBody) throw new Error(); raw = rawBody; }
            else if (Buffer.isBuffer(rawBody) || rawBody instanceof Uint8Array) raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rawBody);
            else { record.state = 'failed'; record.errorCode = 'RAW_BODY_UNAVAILABLE'; this.persist(entry); return; }
        } catch { record.state = 'failed'; record.errorCode = 'INVALID_UTF8'; this.persist(entry); return; }
        // Scope is bound to the selected original request model. Native aliasing/
        // transforms may legitimately change the final model; never scope-shift it.
        try {
            const actualModel = JSON.parse(raw)?.model;
            if (typeof actualModel === 'string' && actualModel !== entry.model) record.metadata.actualModel = modelId(actualModel);
        } catch { /* Unknown final JSON/model is explicit via finalStageError below. */ }
        let stage;
        try { stage = finalStage(raw, entry.source, this.maxBodyBytes); }
        catch {
            record.metadata.finalStageError = 'FINAL_STAGE_UNAVAILABLE';
            stage = { id: 'backend-final', label: 'Final outbound request', messages: [], notes: ['无法解析请求结构，最终请求的原始内容已保存在 rawRequest 中。'] };
        }
        const stageBytes = stage ? Buffer.byteLength(JSON.stringify(stage)) : 0;
        this.makeRoom(size + stageBytes, null, context.id);
        if (this.usedBytes + this.bufferedBytes + size + stageBytes > this.maxTotalBytes) {
            record.state = 'oversize'; record.errorCode = 'INSPECTOR_CAPACITY'; this.persist(entry); return;
        }
        record.rawRequest = raw; record.complete = true;
        if (stage) record.trace.stages.push(stage);
        entry.bytes += size + stageBytes; this.usedBytes += size + stageBytes;
        this.persist(entry);
        return true;
    }); }
    failGoogleTicket(reference, errorCode = 'PREPARE_FAILED') { return this.quiet(() => {
        this.sweep(); const context = this.references.get(reference), entry = this.entries.get(context?.id);
        if (this.closed || !entry || entry.owner !== context.owner || entry.record.sequence !== 0) return;
        entry.record.state = 'failed'; entry.record.errorCode = safeError(errorCode); entry.record.responseAt = new Date(this.now()).toISOString();
    }); }
    finishGoogleDispatch(handle, errorCode, metadata) { return this.quiet(() => {
        const entry = this.active(handle), context = this.dispatches.get(handle);
        if (!entry || context.terminal) return null;
        context.terminal = true; const record = entry.record;
        entry.busy = false; entry.expires = this.now() + this.ttlMs;
        const safeMeta = metadataSafe(metadata);
        Object.assign(record.metadata, safeMeta); record.responseAt = new Date(this.now()).toISOString();
        if (!errorCode && safeMeta.httpStatus >= 400) errorCode = `UPSTREAM_HTTP_${safeMeta.httpStatus}`;
        // Oversize/capture failure remains explicit even if generation succeeds.
        if (record.state === 'oversize' || record.state === 'failed') { this.persist(entry); return; }
        if (errorCode) { record.state = 'failed'; record.errorCode = safeError(errorCode); }
        else if (!record.complete) { record.state = 'failed'; record.errorCode = 'RAW_BODY_UNAVAILABLE'; }
        else record.state = 'responded';
        this.persist(entry);
    }); }
    registerGoogleCapture(handle, cleanup) {
        const entry = this.active(handle); if (!entry || typeof cleanup !== 'function' || entry.cleanups.size > 0) return null;
        entry.cleanups.add(cleanup); return () => entry.cleanups.delete(cleanup);
    }
    reserveCaptureBytes(handle, bytes) {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || !this.active(handle)) return false;
        this.makeRoom(bytes, null, this.dispatches.get(handle)?.id);
        if (this.usedBytes + this.bufferedBytes + bytes > this.maxTotalBytes) return false;
        this.bufferedBytes += bytes; return true;
    }
    releaseCaptureBytes(bytes) { if (Number.isSafeInteger(bytes) && bytes >= 0) this.bufferedBytes = Math.max(0, this.bufferedBytes - bytes); }
    close() {
        clearInterval(this.timer); this.closed = true;
        for (const id of this.entries.keys()) this.drop(id);
        this.entries.clear(); this.latest.clear(); this.tombstones.clear(); this.usedBytes = 0; this.bufferedBytes = 0;
        this.requests = new WeakMap(); this.references = new WeakMap(); this.dispatches = new WeakMap();
    }
}
module.exports = { PromptInspectorStore, PROMPT_INSPECTOR_WIRE_HOOK, PROMPT_INSPECTOR_WIRE_CAPABILITY, FIELD, boundedClone, normalizeTrace, promptInspectorOwner: owner };
