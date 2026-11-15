/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const { PluginError } = require('./errors.cjs');
const { isGemini4Model } = require('./gemini4-models.cjs');
const { getVertexApiHostname } = require('./vertex-endpoint.cjs');

const ALLOWED_GOOGLE_HEADERS = new Set(['content-type', 'authorization', 'x-goog-api-key']);

function escapeRegularExpression(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function parseAndValidateGoogleTarget(rawUrl, { model, region, stream, source = 'vertexai', reverseProxy }, prepared) {
    let target;
    try {
        target = new URL(rawUrl);
    } catch {
        throw new PluginError(500, 'UNSAFE_GOOGLE_TARGET', 'SillyTavern 返回的 Google 请求地址无效。');
    }

    const aiStudio = source === 'makersuite';
    // A ticket may use only the exact base selected for this Studio request.
    // Official requests and Vertex retain their provider allowlist.
    let proxyBase;
    if (aiStudio && reverseProxy) {
        try {
            proxyBase = new URL(reverseProxy);
            if (!['http:', 'https:'].includes(proxyBase.protocol) || proxyBase.username || proxyBase.password
                || proxyBase.search || proxyBase.hash) throw new Error();
        } catch {
            throw new PluginError(500, 'UNSAFE_GOOGLE_TARGET', '保存的 AI Studio 代理基础地址校验失败。');
        }
    }
    const expectedHost = aiStudio ? 'generativelanguage.googleapis.com' : getVertexApiHostname(region);
    const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
    const expectedPath = aiStudio ? new RegExp(
        `^${proxyBase ? escapeRegularExpression(proxyBase.pathname.replace(/\/+$/u, '')) : ''}/v1(?:beta|alpha)?/models/${escapeRegularExpression(model)}:${endpoint}$`, 'u',
    ) : new RegExp(
        `^/${isGemini4Model(model) && prepared ? 'v1(?:beta1)?' : 'v1'}/(?:projects/[a-z0-9][a-z0-9-]{0,62}/locations/${escapeRegularExpression(region)}/)?publishers/google/models/${escapeRegularExpression(model)}:${endpoint}$`,
        'u',
    );

    if (
        (proxyBase ? target.origin !== proxyBase.origin : target.protocol !== 'https:' || target.hostname !== expectedHost || target.port !== '')
        || target.username !== ''
        || target.password !== ''
        || target.hash !== ''
        || !expectedPath.test(target.pathname)
    ) {
        throw new PluginError(500, 'UNSAFE_GOOGLE_TARGET', 'SillyTavern 返回的 Google 请求地址不符合当前服务来源的地址规则。');
    }

    const queryEntries = [...target.searchParams.entries()];
    if (prepared && stream) {
        if (queryEntries.length !== 1 || queryEntries[0][0] !== 'alt' || queryEntries[0][1] !== 'sse') {
            throw new PluginError(500, 'UNSAFE_GOOGLE_TARGET', '保存的流式请求地址校验失败。');
        }
    } else if (queryEntries.length !== 0) {
        throw new PluginError(500, 'UNSAFE_GOOGLE_TARGET', 'Vertex AI 请求地址包含不支持的查询参数。');
    }

    return target;
}

function prepareGoogleTarget(rawUrl, config) {
    const target = parseAndValidateGoogleTarget(rawUrl, config, false);
    if (config.stream) {
        target.searchParams.set('alt', 'sse');
    }
    return target.toString();
}

function validatePreparedGoogleTarget(rawUrl, config) {
    return parseAndValidateGoogleTarget(rawUrl, config, true);
}

function prepareGoogleHeaders(configHeaders, payGoHeaders, { allowUnauthenticated = false } = {}) {
    if (!configHeaders || typeof configHeaders !== 'object' || Array.isArray(configHeaders)) {
        throw new PluginError(500, 'UNSAFE_GOOGLE_HEADERS', 'SillyTavern 返回的 Vertex AI 请求头无效。');
    }

    const headers = {};
    for (const [name, value] of Object.entries(configHeaders)) {
        const normalizedName = name.toLowerCase();
        // ST permits proxies without a password. Omit its empty header rather
        // than falling back to the user's real Google credential.
        if (allowUnauthenticated && normalizedName === 'x-goog-api-key' && (value === '' || value == null)) continue;
        if (!ALLOWED_GOOGLE_HEADERS.has(normalizedName) || typeof value !== 'string' || value.length === 0) {
            throw new PluginError(500, 'UNSAFE_GOOGLE_HEADERS', 'SillyTavern 返回了不支持的 Vertex AI 请求头。');
        }
        headers[name] = value;
    }
    if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
    }
    if (!allowUnauthenticated && !Object.keys(headers).some(name => ['authorization', 'x-goog-api-key'].includes(name.toLowerCase()))) {
        throw new PluginError(500, 'UNSAFE_GOOGLE_HEADERS', 'SillyTavern 未提供 Vertex AI 认证信息。');
    }

    return Object.freeze({ ...headers, ...payGoHeaders });
}

module.exports = {
    prepareGoogleHeaders,
    prepareGoogleTarget,
    validatePreparedGoogleTarget,
};
