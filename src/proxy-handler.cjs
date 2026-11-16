/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const https = require('node:https');
const http = require('node:http');
const { Transform } = require('node:stream');
const { PluginError, sendNodeError } = require('./errors.cjs');
const { describeError } = require('./log-store.cjs');
const { validatePreparedGoogleTarget } = require('./target-policy.cjs');
const { UsageCapture } = require('./usage-capture.cjs');
const { PromptInspectorBodyTap } = require('./prompt-inspector-tap.cjs');
const { GoogleRequestPreviewTap } = require('./google-request-preview.cjs');
const { isGemini4Model, runGemini4Transport } = require('./gemini4-transport.cjs');
const { MAX_GOOGLE_ERROR_BYTES, googleErrorDetails, parseGoogleError } = require('./google-errors.cjs');
const { applyBillingLabels } = require('./billing-labels.cjs');

const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

class ByteLimitTransform extends Transform {
    constructor(limit) {
        super();
        this.limit = limit;
        this.total = 0;
    }

    _transform(chunk, encoding, callback) {
        this.total += chunk.length;
        if (this.total > this.limit) {
            callback(new PluginError(413, 'REQUEST_BODY_TOO_LARGE', '转发给 Vertex AI 的请求内容超过大小上限。'));
            return;
        }
        callback(null, chunk);
    }
}

// Reuse the bounded request stream, buffering only AI Studio JSON because its
// service tier belongs in the body. Responses still stream without buffering.
class FlexBodyTransform extends ByteLimitTransform {
    constructor(limit) {
        super(limit);
        this.chunks = [];
    }

    _transform(chunk, encoding, callback) {
        super._transform(chunk, encoding, (error, data) => {
            if (error) return callback(error);
            this.chunks.push(data);
            callback();
        });
    }

    _flush(callback) {
        try {
            const body = JSON.parse(Buffer.concat(this.chunks).toString('utf8'));
            this.chunks = [];
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Not an object');
            // Remove both spellings so an existing tier cannot override the ticket.
            delete body.serviceTier;
            body.service_tier = 'flex';
            callback(null, JSON.stringify(body));
        } catch {
            callback(new PluginError(400, 'INVALID_GOOGLE_BODY', 'Google AI Studio 请求内容必须是 JSON 对象。'));
        }
    }

    _destroy(error, callback) {
        this.chunks = [];
        callback(error);
    }
}

class BillingBodyTransform extends FlexBodyTransform {
    constructor(limit, labels) { super(limit); this.labels = labels; }
    _flush(callback) {
        try {
            const body = JSON.parse(Buffer.concat(this.chunks).toString('utf8'));
            this.chunks = [];
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
            applyBillingLabels(body, this.labels);
            const bytes = Buffer.from(JSON.stringify(body));
            if (bytes.length > this.limit) return callback(new PluginError(413, 'REQUEST_BODY_TOO_LARGE', '加入账单关联标签后的请求超过大小上限。'));
            callback(null, bytes);
        } catch { callback(new PluginError(400, 'INVALID_GOOGLE_BODY', 'Google 请求内容必须是 JSON 对象。')); }
    }
}

function getBearerSecret(header) {
    if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.length <= 7) {
        throw new PluginError(401, 'INVALID_PROXY_SECRET', '代理凭证无效。');
    }
    return header.slice(7);
}

function parseProxyPath(requestUrl) {
    let parsed;
    try {
        parsed = new URL(requestUrl, 'http://127.0.0.1');
    } catch {
        throw new PluginError(404, 'INVALID_PROXY_PATH', '代理请求路径无效。');
    }

    const match = /^\/proxy\/([A-Za-z0-9_-]+)\/(v1\/publishers\/google|v1(?:beta|alpha)?)\/models\/([^/]+)$/u.exec(parsed.pathname);
    if (!match) {
        throw new PluginError(404, 'INVALID_PROXY_PATH', '代理请求路径无效。');
    }

    try {
        return {
            parsed, ticket: match[1], modelAction: decodeURIComponent(match[3]),
            source: match[2] === 'v1/publishers/google' ? 'vertexai' : 'makersuite',
        };
    } catch {
        throw new PluginError(404, 'INVALID_PROXY_PATH', '代理请求路径无效。');
    }
}

function validateSuffix(parsed, modelAction, ticketData) {
    if (modelAction !== `${ticketData.model}:${ticketData.endpoint}`) {
        throw new PluginError(409, 'PROXY_REQUEST_MISMATCH', '代理请求与其凭证不匹配。');
    }
    const aiStudio = ticketData.source === 'makersuite';
    const expectedSuffix = aiStudio ? new URL(ticketData.targetUrl).pathname.match(/\/v1(?:beta|alpha)?\/models\/[^/]+$/u)?.[0]
        : `/v1/publishers/google/models/${ticketData.model}:${ticketData.endpoint}`;
    if (!expectedSuffix || !parsed.pathname.endsWith(expectedSuffix)) {
        throw new PluginError(409, 'PROXY_REQUEST_MISMATCH', '代理服务来源或 API 版本与其凭证不匹配。');
    }
    const keys = parsed.searchParams.getAll('key');
    if (keys.length > (aiStudio ? 1 : 0)) {
        throw new PluginError(409, 'PROXY_REQUEST_MISMATCH', '代理请求中的凭证参数与其签发记录不匹配。');
    }
    const queryEntries = [...parsed.searchParams.entries()].filter(([name]) => !(aiStudio && name === 'key'));
    if (ticketData.stream) {
        if (queryEntries.length !== 1 || queryEntries[0][0] !== 'alt' || queryEntries[0][1] !== 'sse') {
            throw new PluginError(409, 'PROXY_REQUEST_MISMATCH', '流式代理请求与其凭证不匹配。');
        }
    } else if (queryEntries.length !== 0) {
        throw new PluginError(409, 'PROXY_REQUEST_MISMATCH', '代理请求与其凭证不匹配。');
    }
}

function copyUpstreamHeaders(headers) {
    const result = {};
    for (const [name, value] of Object.entries(headers || {})) {
        if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) {
            result[name] = value;
        }
    }
    return result;
}

function createProxyHandler({
    ticketStore,
    logStore,
    usageStore,
    promptInspectorStore,
    upstreamRequest = (target, options, callback) => (target.protocol === 'http:' ? http : https).request(target, options, callback),
    maxBodyBytes = 500 * 1024 * 1024,
    upstreamTimeoutMs = 31 * 60_000,
} = {}) {
    return function proxyHandler(request, response) {
        const startedAt = Date.now();
        let upstream;
        let bodyStream;
        let previewTap;
        let inspectorTap;
        let inspectorReference;
        let inspectorDispatch;
        let logContext;
        let failureHandled = false;
        let clientGone = false;
        let terminalLogged = false;
        let usageFinalized = false;
        let usageReference;
        let usageCapture;

        const makeLogContext = additional => ({
            ...(logContext || {}),
            durationMs: Date.now() - startedAt,
            ...(additional || {}),
        });
        const logTerminal = (level, event, additional = undefined) => {
            if (terminalLogged) return;
            terminalLogged = true;
            logStore?.server(level, event, makeLogContext(additional), {
                priority: logContext ? 'normal' : 'low',
            });
        };
        const finalizeUsage = (status, errorCode, usage = undefined) => {
            if (usageFinalized || !usageReference) return;
            usageFinalized = true;
            try {
                usageStore?.update(usageReference, { status, errorCode, usage });
            } catch (error) {
                logStore?.server('error', 'usage_ledger_update_failed', makeLogContext(describeError(error)), { priority: 'low' });
            }
        };

        const finishInspection = (code, metadata) => {
            try { if (inspectorDispatch) promptInspectorStore?.finishGoogleDispatch(inspectorDispatch, code, metadata); }
            catch { /* Inspection never blocks or logs generation. */ }
        };
        const beginInspection = metadata => {
            try { return inspectorReference ? promptInspectorStore?.beginGoogleDispatch(inspectorReference, metadata) : null; }
            catch { return null; }
        };

        const fail = error => {
            if (failureHandled || clientGone) return;
            failureHandled = true;
            finishInspection(error?.code || 'VERTEX_UPSTREAM_FAILED');
            finalizeUsage('failed', error?.code || 'VERTEX_UPSTREAM_FAILED', usageCapture?.finish());
            logTerminal('error', 'proxy_failed', describeError(error));
            upstream?.destroy();
            bodyStream?.destroy();
            previewTap?.destroy();
            inspectorTap?.destroy();
            sendNodeError(response, error);
        };

        // Until a ticket has been authenticated, this is browser-controlled
        // reject noise. Keep it in the bounded low-priority budget.
        logStore?.server('info', 'proxy_request_received', undefined, { priority: 'low' });
        try {
            if (request.method !== 'POST') {
                throw new PluginError(405, 'METHOD_NOT_ALLOWED', '本地回环代理仅支持 POST 请求。');
            }
            const contentType = request.headers['content-type'];
            if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
                throw new PluginError(415, 'JSON_REQUIRED', '本地回环代理仅支持 JSON 请求内容。');
            }
            const declaredLength = Number(request.headers['content-length']);
            if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
                throw new PluginError(413, 'REQUEST_BODY_TOO_LARGE', '转发给 Vertex AI 的请求内容超过大小上限。');
            }

            const { parsed, ticket, modelAction, source } = parseProxyPath(request.url);
            // ST's native AI Studio serializer puts the disposable proxy secret
            // in ?key=. It never becomes the Google credential or upstream query.
            const proxySecret = source === 'makersuite'
                ? parsed.searchParams.get('key') || request.headers['x-goog-api-key'] || getBearerSecret(request.headers.authorization)
                : getBearerSecret(request.headers.authorization);
            const ticketData = ticketStore.consume(
                ticket,
                proxySecret,
                data => {
                    if (source !== (data.source || 'vertexai')) {
                        throw new PluginError(409, 'PROXY_REQUEST_MISMATCH', '代理服务来源与其凭证不匹配。');
                    }
                    validateSuffix(parsed, modelAction, data);
                },
            );
            logContext = {
                model: ticketData.model,
                provider: ticketData.source || 'vertexai',
                tier: ticketData.tier,
                region: ticketData.region,
                stream: ticketData.stream,
            };
            usageReference = ticketData.usageReference;
            inspectorReference = ticketData.promptInspectorReference;

            // Revalidate the stored URL immediately before opening the socket. Tickets
            // only contain URLs produced by target-policy and cannot be client supplied.
            const target = validatePreparedGoogleTarget(ticketData.targetUrl, ticketData);

            if (isGemini4Model(ticketData.model)) {
                let aggregateUsage;
                usageCapture = { finish: () => aggregateUsage };
                runGemini4Transport({
                    request, response, ticketData, target, upstreamRequest,
                    maxBodyBytes, upstreamTimeoutMs,
                    ...(ticketData.cacheWarm === true ? { maxHops: 1 } : {}),
                    onRequest: (bytes, info) => {
                        // Each Gemini4 continuation is a separate final dispatch.
                        finishInspection(undefined, { httpStatus: 200 });
                        inspectorDispatch = beginInspection({ transport: 'google-gemini4', tier: ticketData.tier, region: ticketData.region, stream: ticketData.stream,
                            cacheBoundaryStatus: info?.cacheBoundaryStatus, cacheBoundaryStableTextChars: info?.cacheBoundaryStableTextChars,
                            ...(ticketData.cacheWarm === true ? { cacheWarm: true } : {}) });
                        try { promptInspectorStore?.captureGoogleBody(inspectorDispatch, bytes); } catch {}
                        try { usageStore?.captureGoogleRequest?.(usageReference, bytes, info, ticketData.worldInfoOrder); }
                        catch { logStore?.server('warn', 'request_preview_capture_failed', makeLogContext(), { priority: 'low' }); }
                    },
                    onUsage: (usage, complete) => {
                        aggregateUsage = usage;
                        if (complete) {
                            finishInspection(undefined, { httpStatus: 200 });
                            finalizeUsage(usage ? 'complete' : 'incomplete', usage ? undefined : 'USAGE_METADATA_MISSING', usage);
                            logTerminal('info', 'proxy_completed', { statusCode: 200 });
                        }
                    },
                }).catch(fail);
                return;
            }

            inspectorDispatch = beginInspection({ transport: 'google-proxy', tier: ticketData.tier, region: ticketData.region, stream: ticketData.stream });
            upstream = upstreamRequest(target, {
                method: 'POST',
                headers: ticketData.headers,
                // node:https does not follow redirects and has no implicit fetch-style
                // response-header timeout, which is required for long Flex requests.
            }, upstreamResponse => {
                if (response.writableEnded) {
                    clientGone = true;
                    finishInspection('CLIENT_DISCONNECTED');
                    finalizeUsage('incomplete', 'CLIENT_DISCONNECTED', usageCapture?.finish());
                    logTerminal('warn', 'proxy_client_disconnected');
                    upstreamResponse.destroy();
                    return;
                }
                const statusCode = upstreamResponse.statusCode || 502;
                if (statusCode >= 300 && statusCode < 400) {
                    // Relaying Location would let SillyTavern's outer node-fetch follow
                    // the redirect after it leaves this allowlisted transport.
                    upstreamResponse.destroy();
                    fail(new PluginError(502, 'VERTEX_REDIRECT_REJECTED', 'Vertex AI 上游返回了重定向，当前传输不支持跟随重定向。'));
                    return;
                }
                const responseHeaders = copyUpstreamHeaders(upstreamResponse.headers);
                if (upstreamResponse.statusMessage) {
                    response.writeHead(statusCode, upstreamResponse.statusMessage, responseHeaders);
                } else {
                    response.writeHead(statusCode, responseHeaders);
                }
                logStore?.server(statusCode >= 400 ? 'warn' : 'info', 'proxy_upstream_response', makeLogContext({ statusCode }));
                const encoding = upstreamResponse.headers?.['content-encoding'];
                const compressed = Boolean(encoding && String(encoding).toLowerCase() !== 'identity');
                let errorDetails = statusCode >= 400 ? googleErrorDetails(statusCode) : undefined;
                let errorChunks = errorDetails && !compressed ? [] : null;
                let errorBytes = 0;
                if (!compressed) {
                    usageCapture = new UsageCapture({ stream: ticketData.stream,
                        officialGoogle: (ticketData.source || 'vertexai') === 'vertexai'
                            || ticketData.source === 'makersuite' && !ticketData.reverseProxy });
                    upstreamResponse.on('data', chunk => {
                        try { usageCapture.write(chunk); } catch { /* Usage capture is observational. */ }
                        if (errorChunks) {
                            errorBytes += chunk.length;
                            if (errorBytes <= MAX_GOOGLE_ERROR_BYTES) errorChunks.push(chunk);
                            else errorChunks = null;
                        }
                    });
                }
                upstreamResponse.once('end', () => {
                    if (errorChunks) {
                        errorDetails = googleErrorDetails(statusCode, parseGoogleError(Buffer.concat(errorChunks)));
                        errorChunks = null;
                    }
                    finishInspection(statusCode >= 400 ? `UPSTREAM_HTTP_${statusCode}` : undefined, { httpStatus: statusCode });
                    const usage = usageCapture?.finish({ complete: statusCode >= 200 && statusCode < 300 }) || null;
                    if (statusCode >= 400) finalizeUsage('failed', `UPSTREAM_HTTP_${statusCode}`, usage);
                    else if (usageCapture?.limitExceeded) finalizeUsage('incomplete', 'USAGE_CAPTURE_LIMIT', usage);
                    else if (ticketData.stream && usageCapture && !usageCapture.terminalSeen) finalizeUsage('incomplete', 'USAGE_STREAM_INCOMPLETE', usage);
                    else if (usage) finalizeUsage('complete', undefined, usage);
                    else finalizeUsage('incomplete', compressed ? 'USAGE_COMPRESSED_RESPONSE'
                        : usageCapture?.limitExceeded ? 'USAGE_CAPTURE_LIMIT' : 'USAGE_METADATA_MISSING');
                });
                upstreamResponse.on('error', error => {
                    failureHandled = true;
                    finishInspection('UPSTREAM_RESPONSE_STREAM_FAILED', { httpStatus: statusCode });
                    finalizeUsage('incomplete', 'UPSTREAM_RESPONSE_STREAM_FAILED', usageCapture?.finish());
                    logTerminal('error', 'proxy_response_stream_failed', describeError(error));
                    response.destroy();
                });
                response.once('finish', () => {
                    logTerminal(statusCode >= 400 ? 'warn' : 'info', 'proxy_completed', { statusCode, ...errorDetails });
                });
                upstreamResponse.pipe(response);
            });
            logStore?.server('info', 'proxy_forward_started', makeLogContext());
            upstream.setTimeout?.(upstreamTimeoutMs, () => {
                fail(new PluginError(504, 'VERTEX_UPSTREAM_TIMEOUT', 'Vertex AI 上游请求超时，请稍后重试或检查网络与代理连接。'));
            });

            bodyStream = ticketData.source === 'makersuite' && ticketData.tier === 'flex'
                ? new FlexBodyTransform(maxBodyBytes) : ticketData.billingLabels
                    ? new BillingBodyTransform(maxBodyBytes, ticketData.billingLabels) : new ByteLimitTransform(maxBodyBytes);
            bodyStream.on('error', fail);
            upstream.on('error', error => {
                fail(error instanceof PluginError
                    ? error
                    : new PluginError(502, 'VERTEX_UPSTREAM_FAILED', 'Vertex AI 上游连接失败，请检查网络与代理连接。', { cause: error }));
            });
            request.once('aborted', () => {
                if (clientGone) return;
                clientGone = true;
                finishInspection('CLIENT_DISCONNECTED');
                finalizeUsage('incomplete', 'CLIENT_DISCONNECTED', usageCapture?.finish());
                logTerminal('warn', 'proxy_client_disconnected');
                upstream.destroy();
                bodyStream.destroy();
                previewTap?.destroy();
                inspectorTap?.destroy();
            });
            request.once('error', error => {
                fail(new PluginError(400, 'PROXY_REQUEST_STREAM_FAILED', '本地回环请求的数据流读取失败。', { cause: error }));
            });
            response.once('close', () => {
                if (!response.writableEnded) {
                    clientGone = true;
                    finishInspection('CLIENT_DISCONNECTED');
                    finalizeUsage('incomplete', 'CLIENT_DISCONNECTED', usageCapture?.finish());
                    logTerminal('warn', 'proxy_client_disconnected');
                    upstream.destroy();
                    bodyStream.destroy();
                    previewTap?.destroy();
                    inspectorTap?.destroy();
                }
            });
            // Inspector captures independently of the ledger, after ALL body transforms.
            let outgoing = request.pipe(bodyStream);
            if (inspectorDispatch) {
                try {
                    inspectorTap = new PromptInspectorBodyTap({ store: promptInspectorStore, handle: inspectorDispatch });
                    outgoing = outgoing.pipe(inspectorTap);
                } catch { finishInspection('RAW_BODY_UNAVAILABLE'); }
            }
            if (usageReference && typeof usageStore?.captureGoogleRequest === 'function') {
                previewTap = new GoogleRequestPreviewTap({ onComplete: (bytes, info) => {
                    try { usageStore.captureGoogleRequest(usageReference, bytes, info, ticketData.worldInfoOrder); }
                    catch { logStore?.server('warn', 'request_preview_capture_failed', makeLogContext(), { priority: 'low' }); }
                } });
                previewTap.on('error', fail);
                outgoing = outgoing.pipe(previewTap);
            }
            outgoing.pipe(upstream);
        } catch (error) {
            fail(error);
        }
    };
}

module.exports = {
    ByteLimitTransform,
    BillingBodyTransform,
    copyUpstreamHeaders,
    createProxyHandler,
    parseProxyPath,
    validateSuffix,
};
