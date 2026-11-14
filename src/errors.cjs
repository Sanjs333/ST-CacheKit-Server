/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const NETWORK_FAILURES = new Map([
    ['ETIMEDOUT', '请求转发超时'],
    ['ESOCKETTIMEDOUT', '请求转发超时'],
    ['UND_ERR_CONNECT_TIMEOUT', '建立请求连接超时'],
    ['UND_ERR_HEADERS_TIMEOUT', '等待服务器响应超时'],
    ['UND_ERR_BODY_TIMEOUT', '读取服务器响应超时'],
    ['ECONNRESET', '请求连接被中断'],
    ['ECONNREFUSED', '请求连接被拒绝'],
    ['ENOTFOUND', '请求目标的域名解析失败'],
    ['EAI_AGAIN', '请求目标的域名解析暂时失败'],
]);

class PluginError extends Error {
    constructor(status, code, message, options = undefined) {
        super(message, options);
        this.name = 'PluginError';
        this.status = status;
        this.code = code;
        // Browser-safe structured context; never put credentials here.
        if (options?.details) this.details = options.details;
    }
}

function asPluginError(error) {
    if (error instanceof PluginError) {
        return error;
    }

    const networkCode = [error?.code, error?.cause?.code].find(code => NETWORK_FAILURES.has(code));
    return new PluginError(
        500,
        'INTERNAL_ERROR',
        networkCode
            ? `${NETWORK_FAILURES.get(networkCode)}（${networkCode}）。请稍后重试，或检查网络与代理连接。`
            : '提示词缓存优化服务端插件未能完成请求，请查看运行日志中的错误详情。',
        { cause: error, ...(networkCode ? { details: { networkCode } } : {}) },
    );
}

function errorPayload(error) {
    return {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
    };
}

function sendExpressError(response, error) {
    const safeError = asPluginError(error);
    return response.status(safeError.status).json({ error: true, ...errorPayload(safeError) });
}

function sendNodeError(response, error) {
    const safeError = asPluginError(error);
    // An ended response already delivered its own terminal event; destroying
    // it now could discard that event before it is flushed.
    if (response.writableEnded) return;
    if (response.headersSent) {
        response.destroy();
        return;
    }

    const body = Buffer.from(JSON.stringify({ error: true, ...errorPayload(safeError) }));

    response.writeHead(safeError.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
    });
    response.end(body);
}

module.exports = {
    PluginError,
    asPluginError,
    errorPayload,
    sendExpressError,
    sendNodeError,
};
