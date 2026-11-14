/* Plugin-owned final native request relay. SPDX-License-Identifier: MPL-2.0. */
'use strict';

const http = require('node:http');
const https = require('node:https');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { PluginError, sendNodeError, sendExpressError } = require('./errors.cjs');
const { validateChatId } = require('./protocol.cjs');
const { promptInspectorOwner } = require('./prompt-inspector-store.cjs');
const { PromptInspectorBodyTap } = require('./prompt-inspector-tap.cjs');

const SOURCES = new Set(['openai', 'claude', 'custom']);
const FIELDS = new Set(['version', 'source', 'model', 'chatId', 'promptInspectorTicket',
    'reverse_proxy', 'proxy_password', 'secret_id', 'custom_url', 'custom_include_headers', 'custom_api_format']);
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade']);
const PRIVATE_HEADERS = new Set(['host', 'authorization', 'x-api-key', 'x-goog-api-key', 'cookie']);
const OPENAI_SUFFIXES = new Set(['/chat/completions', '/completions', '/responses']);

function unsupported(reason) {
    return new PluginError(503, 'NATIVE_RELAY_UNSUPPORTED',
        '当前配置无法捕获原生接口的最终请求。', { details: { reason } });
}
function authenticatedOwner(request) {
    const key = promptInspectorOwner(request);
    if (!key) throw new PluginError(401, 'AUTHENTICATED_USER_REQUIRED', '请先登录用户账号，并确认用户数据目录可用。');
    return key;
}
function validateNativePrepare(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.version !== 1 || !SOURCES.has(body.source)
        || Object.keys(body).some(key => !FIELDS.has(key))) {
        throw new PluginError(400, 'INVALID_NATIVE_PREPARE', '原生请求的准备信息无效。');
    }
    const config = {};
    for (const key of Object.keys(body)) {
        const descriptor = Object.getOwnPropertyDescriptor(body, key);
        if (!descriptor || !('value' in descriptor)) throw new PluginError(400, 'INVALID_NATIVE_PREPARE', '原生请求的准备信息无效。');
        const value = descriptor.value;
        const unsafeText = key === 'custom_include_headers' ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u : /[\x00-\x1f\x7f]/u;
        if (key !== 'version' && (typeof value !== 'string' || value.length > 32_768 || unsafeText.test(value))) {
            throw new PluginError(400, 'INVALID_NATIVE_PREPARE', '原生请求的准备信息无效。');
        }
        config[key] = value;
    }
    if (typeof config.model !== 'string' || !config.model || config.model.length > 256 || config.model.trim() !== config.model
        || typeof config.promptInspectorTicket !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(config.promptInspectorTicket)) {
        throw new PluginError(400, 'INVALID_NATIVE_PREPARE', '请求必须包含模型和提示词查看凭证。');
    }
    validateChatId(config.chatId);
    if (config.secret_id && (config.secret_id.length > 256 || config.secret_id.trim() !== config.secret_id)) throw unsupported('INVALID_SECRET_SELECTION');
    if (config.source === 'custom') {
        const headers = config.custom_include_headers?.trim();
        if (headers) {
            let empty = false;
            try { const parsed = JSON.parse(headers); empty = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0; }
            catch { /* YAML or nonempty custom headers require a separate adapter. */ }
            if (!empty) throw unsupported('CUSTOM_HEADERS');
        }
        if (config.custom_api_format && config.custom_api_format !== 'openai') throw unsupported('CUSTOM_API_FORMAT');
    }
    return Object.freeze(config);
}
function nativeTargetBase(config) {
    const supplied = config.source === 'custom' ? config.custom_url : config.reverse_proxy
        || (config.source === 'claude' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1');
    if (typeof supplied !== 'string' || !supplied || supplied.length > 8192 || supplied.trim() !== supplied) throw unsupported('TARGET_URL');
    let parsed;
    try { parsed = new URL(supplied); } catch { throw unsupported('TARGET_URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw unsupported('TARGET_URL');
    if (parsed.search || parsed.hash) throw unsupported('TARGET_QUERY_OR_FRAGMENT');
    // Stock normalizes OpenAI/Claude bases, but concatenates custom_url as-is.
    // Preserve trailing slashes, including the host's resulting double slash.
    return config.source === 'custom' ? supplied : parsed.toString();
}
function filteredHeaders(headers, privateHop = false) {
    const blocked = new Set(HOP_HEADERS);
    const connection = headers?.connection;
    if (typeof connection === 'string') for (const name of connection.split(',')) blocked.add(name.trim().toLowerCase());
    if (privateHop) for (const name of PRIVATE_HEADERS) blocked.add(name);
    const result = {};
    for (const [name, value] of Object.entries(headers || {})) {
        if (value !== undefined && !blocked.has(name.toLowerCase())) result[name] = value;
    }
    return result;
}
function nativePath(requestUrl) {
    // No normalization that could turn a traversal/extra query into a valid suffix.
    const match = /^\/native-proxy\/([A-Za-z0-9_-]{16,128})(\/chat\/completions|\/completions|\/responses|\/messages)$/u.exec(requestUrl || '');
    if (!match) throw new PluginError(404, 'INVALID_NATIVE_PROXY_PATH', '原生请求的代理路径无效。');
    return { ticket: match[1], suffix: match[2] };
}
function nativeProxySecret(request, data) {
    if (data.source === 'claude') {
        const value = request.headers['x-api-key'];
        return typeof value === 'string' ? value : undefined;
    }
    const value = request.headers.authorization;
    return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : undefined;
}

function createNativeRelay({ ticketStore, promptInspectorStore,
    upstreamRequest = (target, options, callback) => (target.protocol === 'http:' ? http : https).request(target, options, callback),
    readinessRequest = (target, options, callback) => http.request(target, options, callback),
    readinessTimeoutMs = 1500, upstreamTimeoutMs = 31 * 60_000,
} = {}) {
    let server, baseUrl, readinessMarker;

    function handle(request, response) {
        response.setHeader('Cache-Control', 'no-store');
        if (request.method === 'GET' && request.url === '/native-ready') {
            response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(readinessMarker) });
            response.end(readinessMarker);
            return;
        }
        let upstream, upstreamResponse, tap, handleRef;
        let terminal = false;
        const finish = (code, metadata) => { try { if (handleRef) promptInspectorStore?.finishGoogleDispatch(handleRef, code, metadata); } catch {} };
        const fail = error => {
            if (terminal) return;
            terminal = true;
            finish(error?.code);
            request.unpipe(); tap?.unpipe(); tap?.destroy();
            upstream?.destroy(); upstreamResponse?.destroy();
            request.resume();
            sendNodeError(response, error);
        };
        const clientGone = () => {
            if (terminal || response.writableEnded) return;
            terminal = true; finish('CLIENT_DISCONNECTED');
            request.unpipe(); tap?.unpipe(); tap?.destroy();
            upstream?.destroy(); upstreamResponse?.destroy();
        };
        request.once('error', () => fail(new PluginError(400, 'NATIVE_RELAY_REQUEST_FAILED', '原生请求数据流读取失败。')));
        request.once('aborted', clientGone);
        response.once('error', clientGone);
        response.once('close', clientGone);
        try {
            if (request.method !== 'POST') throw new PluginError(405, 'METHOD_NOT_ALLOWED', '原生请求转发仅支持 POST 请求。');
            const { ticket, suffix } = nativePath(request.url);
            // Auth header depends on the source bound to this ticket. A validator
            // sees the data only after the disposable secret is authenticated.
            const bearer = typeof request.headers.authorization === 'string' && request.headers.authorization.startsWith('Bearer ')
                ? request.headers.authorization.slice(7) : undefined;
            const suppliedSecret = bearer || request.headers['x-api-key'];
            const data = ticketStore.consume(ticket, suppliedSecret, candidate => {
                const allowed = candidate.source === 'claude' ? suffix === '/messages' : OPENAI_SUFFIXES.has(suffix);
                if (!allowed || nativeProxySecret(request, candidate) !== suppliedSecret) throw new PluginError(409, 'NATIVE_PROXY_MISMATCH', '原生代理请求与其凭证不匹配。');
            });
            const target = new URL(data.targetBase + suffix);
            const headers = filteredHeaders(request.headers, true);
            headers[data.authorization.headerName] = data.authorization.headerValue;
            try { if (data.promptInspectorReference) handleRef = promptInspectorStore?.beginGoogleDispatch(data.promptInspectorReference, { transport: 'native-loopback-http' }); } catch {}
            // Node's normal global HTTP/HTTPS agents retain the host's proxy and
            // private-network policy. No agent/fetch/global monkeypatch is used.
            upstream = upstreamRequest(target, { method: 'POST', headers }, incoming => {
                upstreamResponse = incoming;
                if (terminal) { incoming.destroy(); return; }
                const status = incoming.statusCode || 502;
                if (status >= 300 && status < 400) {
                    // Returning Location lets stock fetch follow it with the
                    // temporary local credential. Reject rather than leak it.
                    fail(new PluginError(502, 'NATIVE_RELAY_REDIRECT_REJECTED', '原生请求转发不支持上游重定向。'));
                    return;
                }
                try { response.writeHead(status, filteredHeaders(incoming.headers)); }
                catch { fail(new PluginError(502, 'NATIVE_RELAY_RESPONSE_FAILED', '原生接口的上游响应头无效。')); return; }
                incoming.once('error', () => fail(new PluginError(502, 'NATIVE_RELAY_RESPONSE_FAILED', '原生接口的上游响应流读取失败。')));
                incoming.once('aborted', () => fail(new PluginError(502, 'NATIVE_RELAY_RESPONSE_FAILED', '原生接口的上游响应流读取失败。')));
                incoming.once('end', () => { if (!terminal) { terminal = true; finish(undefined, { httpStatus: status }); } });
                incoming.pipe(response);
            });
            upstream.once('error', () => fail(new PluginError(502, 'NATIVE_RELAY_UPSTREAM_FAILED', '原生接口的上游连接失败，请检查网络与代理连接。')));
            upstream.setTimeout?.(upstreamTimeoutMs, () => fail(new PluginError(504, 'NATIVE_RELAY_UPSTREAM_TIMEOUT', '原生接口的上游请求超时，请稍后重试或检查网络与代理连接。')));
            let outgoing = request;
            if (handleRef) {
                try { tap = new PromptInspectorBodyTap({ store: promptInspectorStore, handle: handleRef }); outgoing = request.pipe(tap); }
                catch { finish('RAW_BODY_UNAVAILABLE'); }
            }
            outgoing.pipe(upstream);
        } catch (error) { fail(error instanceof PluginError ? error : new PluginError(502, 'NATIVE_RELAY_UPSTREAM_FAILED', '原生请求转发失败。')); }
    }

    const relay = {
        get available() { return Boolean(server?.listening && baseUrl); },
        get baseUrl() { if (!relay.available) throw unsupported('RELAY_UNAVAILABLE'); return baseUrl; },
        async start() {
            if (server) throw new Error('原生请求转发服务已在运行。');
            readinessMarker = randomBytes(32).toString('base64url');
            const created = http.createServer(handle);
            server = created;
            created.requestTimeout = 0; created.headersTimeout = 60_000; created.keepAliveTimeout = 5000;
            try {
                await new Promise((resolve, reject) => {
                    created.once('error', reject);
                    created.listen(0, '127.0.0.1', () => { created.removeListener('error', reject); resolve(); });
                });
                const address = created.address();
                if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw unsupported('RELAY_UNAVAILABLE');
                baseUrl = `http://127.0.0.1:${address.port}`;
            } catch (error) { await relay.close(); throw error; }
        },
        verifyLocalHop() {
            if (!relay.available) return Promise.reject(unsupported('RELAY_UNAVAILABLE'));
            const target = new URL(baseUrl + '/native-ready');
            const expected = readinessMarker;
            return new Promise((resolve, reject) => {
                let probe, reply, settled = false;
                const finish = error => {
                    if (settled) return; settled = true; clearTimeout(timeout);
                    if (error) { probe?.destroy(); reply?.destroy(); reject(unsupported('LOCAL_HOP_UNAVAILABLE')); }
                    else resolve();
                };
                const timeout = setTimeout(() => finish(true), readinessTimeoutMs); timeout.unref?.();
                try {
                    probe = readinessRequest(target, { method: 'GET', headers: { Accept: 'text/plain' } }, incoming => {
                        reply = incoming;
                        if (settled) { incoming.destroy(); return; }
                        if (incoming.statusCode !== 200) { finish(true); return; }
                        let text = '';
                        incoming.on('data', bytes => {
                            if (text.length + bytes.length > 128) { finish(true); return; }
                            text += bytes.toString('utf8');
                        });
                        incoming.once('error', () => finish(true)); incoming.once('aborted', () => finish(true));
                        incoming.once('end', () => {
                            const actual = Buffer.from(text), wanted = Buffer.from(expected);
                            finish(actual.length !== wanted.length || !timingSafeEqual(actual, wanted));
                        });
                    });
                    probe.once('error', () => finish(true)); probe.end();
                } catch { finish(true); }
            });
        },
        async close() {
            const previous = server; server = undefined; baseUrl = undefined; readinessMarker = undefined;
            if (!previous) return;
            const done = new Promise(resolve => previous.close(() => resolve()));
            previous.closeAllConnections?.(); await done;
        },
    };
    return relay;
}

function registerNativeRelayRoutes(router, { stRuntime, nativeTicketStore, nativeRelay, promptInspectorStore }) {
    router.post('/native-prepare', async (request, response) => {
        response.set?.('Cache-Control', 'no-store');
        let reservation, reference, issued;
        try {
            const owned = authenticatedOwner(request), config = validateNativePrepare(request.body);
            if (!nativeRelay?.available || typeof stRuntime?.getNativeAuthorization !== 'function') throw unsupported('RELAY_UNAVAILABLE');
            const targetBase = nativeTargetBase(config);
            if (new URL(targetBase).origin === new URL(nativeRelay.baseUrl).origin) throw unsupported('RELAY_TARGET');
            reservation = nativeTicketStore.reserve(owned);
            await nativeRelay.verifyLocalHop();
            const authorization = await stRuntime.getNativeAuthorization(request, config);
            if (authenticatedOwner(request) !== owned || request.aborted || response.destroyed) throw unsupported('PREPARE_ABORTED');
            try { reference = promptInspectorStore?.bindNativeTicket(request, config); } catch {}
            issued = nativeTicketStore.commit(reservation, { source: config.source, model: config.model,
                chatId: config.chatId, targetBase, authorization, ...(reference ? { promptInspectorReference: reference } : {}) });
            reservation = undefined;
            const proxyUrl = nativeRelay.baseUrl + '/native-proxy/' + issued.ticket;
            const requestOverrides = config.source === 'custom'
                ? { custom_url: proxyUrl, custom_include_headers: JSON.stringify({ Authorization: 'Bearer ' + issued.proxySecret }) }
                : { reverse_proxy: proxyUrl, proxy_password: issued.proxySecret };
            return response.json({ ok: true, protocolVersion: 2, transport: 'native-loopback-http', source: config.source,
                ticket: issued.ticket, proxyUrl, proxySecret: issued.proxySecret,
                expiresAt: new Date(issued.expiresAt).toISOString(), requestOverrides });
        } catch (error) {
            if (reservation) nativeTicketStore?.release(reservation);
            if (issued) { try { nativeTicketStore.revoke(issued.ticket, authenticatedOwner(request)); } catch { /* Owner mismatch never revokes another lease. */ } }
            try { if (reference) promptInspectorStore?.failGoogleTicket(reference, 'PREPARE_FAILED'); } catch {}
            if (request.aborted || response.destroyed) return;
            return sendExpressError(response, error);
        }
    });
    router.delete('/native-prepare', (request, response) => {
        response.set?.('Cache-Control', 'no-store');
        try {
            const owned = authenticatedOwner(request), ticket = request.query?.ticket;
            if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(ticket)) throw new PluginError(400, 'INVALID_NATIVE_TICKET', '原生请求转发凭证无效。');
            const revoked = nativeTicketStore?.revoke(ticket, owned) ?? false;
            return response.json({ ok: true, revoked });
        } catch (error) { return sendExpressError(response, error); }
    });
}

module.exports = { createNativeRelay, registerNativeRelayRoutes, validateNativePrepare, nativeTargetBase };
