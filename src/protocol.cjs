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

const PROTOCOL_VERSION = 2;
const PLUGIN_ID = 'vertex-paygo';
const PLUGIN_VERSION = '1.1.1';
const COMPATIBLE_ST_RANGE = '>=1.14.0';
const TIERS = Object.freeze(['standard', 'flex']);
const AUTH_MODES = Object.freeze(['express', 'full']);

function requireCanonicalString(value, field, pattern, maxLength = 128) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.trim() !== value || !pattern.test(value)) {
        throw new PluginError(400, 'INVALID_PREPARE_REQUEST', `${field} 字段无效。`);
    }
    return value;
}

function validateChatId(value) {
    return requireCanonicalString(value, 'usage chat ID', /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, 128);
}

function validateUsagePrice(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new PluginError(400, 'INVALID_PREPARE_REQUEST', '用量计费单价无效。');
    }
    const allowed = new Set(['input', 'cachedInput', 'output', 'longContextThreshold', 'longInput', 'longCachedInput', 'longOutput']);
    if (Object.keys(value).some(key => !allowed.has(key))) {
        throw new PluginError(400, 'INVALID_PREPARE_REQUEST', '用量计费单价包含无效字段。');
    }
    for (const field of ['input', 'cachedInput', 'output']) {
        if (!Number.isFinite(value[field]) || value[field] < 0) {
            throw new PluginError(400, 'INVALID_PREPARE_REQUEST', `用量计费单价 ${field} 无效。`);
        }
    }
    const result = { input: value.input, cachedInput: value.cachedInput, output: value.output };
    if (value.longContextThreshold !== undefined) {
        if (!Number.isSafeInteger(value.longContextThreshold) || value.longContextThreshold <= 0) {
            throw new PluginError(400, 'INVALID_PREPARE_REQUEST', '长上下文阈值 longContextThreshold 无效。');
        }
        result.longContextThreshold = value.longContextThreshold;
        const longFields = ['longInput', 'longCachedInput', 'longOutput'];
        const suppliedLongFields = longFields.filter(field => value[field] !== undefined);
        if (suppliedLongFields.length !== 0 && suppliedLongFields.length !== longFields.length) {
            throw new PluginError(400, 'INVALID_PREPARE_REQUEST', '长上下文的输入和输出单价必须同时提供。');
        }
        for (const field of suppliedLongFields) {
            if (!Number.isFinite(value[field]) || value[field] < 0) {
                throw new PluginError(400, 'INVALID_PREPARE_REQUEST', `用量计费单价 ${field} 无效。`);
            }
            result[field] = value[field];
        }
    } else if (['longInput', 'longCachedInput', 'longOutput'].some(field => value[field] !== undefined)) {
        throw new PluginError(400, 'INVALID_PREPARE_REQUEST', '配置长上下文单价时必须提供 longContextThreshold 阈值。');
    }
    return Object.freeze(result);
}

// Transient verification text: ticket memory only, never Google input or logs.
function validateWorldInfoOrderPlan(value) {
    if (value === undefined || value === null) return undefined;
    const fail = () => { throw new PluginError(400, 'INVALID_WORLDINFO_ORDER_PLAN', '世界书排序方案无效或超过限制。'); };
    const object = item => item && typeof item === 'object' && !Array.isArray(item);
    const id = item => typeof item === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(item);
    if (!object(value) || value.version !== 1 || !id(value.token) || !Array.isArray(value.groups) || !value.groups.length || value.groups.length > 32
        || Object.keys(value).some(key => !['version', 'token', 'groups'].includes(key))) fail();
    let count = 0, bytes = 0;
    const groupIds = new Set(), itemIds = new Set();
    const groups = value.groups.map(group => {
        if (!object(group) || !id(group.id) || groupIds.has(group.id) || !Array.isArray(group.items) || !group.items.length
            || Object.keys(group).some(key => !['id', 'items'].includes(key))) fail();
        groupIds.add(group.id);
        const items = group.items.map(item => {
            if (!object(item) || !id(item.id) || itemIds.has(item.id) || typeof item.text !== 'string' || !item.text.length || item.text.length > 32768
                || Object.keys(item).some(key => !['id', 'text'].includes(key))) fail();
            itemIds.add(item.id); count++; bytes += Buffer.byteLength(item.text, 'utf8');
            if (count > 128 || bytes > 128 * 1024) fail();
            return { id: item.id, text: item.text };
        });
        return { id: group.id, items };
    });
    return { version: 1, token: value.token, groups };
}

function validatePreparePayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new PluginError(400, 'INVALID_PREPARE_REQUEST', '准备请求的内容必须是对象。');
    }
    if (body.protocolVersion !== PROTOCOL_VERSION) {
        throw new PluginError(409, 'PROTOCOL_MISMATCH', `需要使用插件协议 v${PROTOCOL_VERSION}。`);
    }
    const source = body.chat_completion_source;
    if (!['vertexai', 'makersuite'].includes(source)) {
        throw new PluginError(400, 'GOOGLE_ONLY', '仅支持 Vertex AI 和 Google AI Studio 服务来源。');
    }
    if (source !== 'makersuite' && (Object.hasOwn(body, 'reverse_proxy') || Object.hasOwn(body, 'proxy_password'))) {
        throw new PluginError(400, 'UPSTREAM_PROXY_UNSUPPORTED', '当前传输方式不支持沿用已有反向代理设置。');
    }
    let reverseProxy;
    let proxyPassword;
    if (Object.hasOwn(body, 'reverse_proxy')) {
        try {
            if (typeof body.reverse_proxy !== 'string' || !body.reverse_proxy || body.reverse_proxy.length > 4096
                || body.reverse_proxy.trim() !== body.reverse_proxy || /[\s\\]/u.test(body.reverse_proxy)) throw new Error();
            const url = new URL(body.reverse_proxy);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
            reverseProxy = url.toString().replace(/\/+$/u, '');
        } catch {
            throw new PluginError(400, 'INVALID_REVERSE_PROXY', 'AI Studio 反向代理必须是 HTTP(S) 基础地址，不能包含账号凭证、查询参数或片段。');
        }
        proxyPassword = body.proxy_password ?? '';
        if (typeof proxyPassword !== 'string' || proxyPassword.length > 8192 || /[^\t\x20-\x7e\x80-\xff]/u.test(proxyPassword)) {
            throw new PluginError(400, 'INVALID_PROXY_PASSWORD', 'AI Studio 代理密码无效。');
        }
    } else if (Object.hasOwn(body, 'proxy_password')) {
        throw new PluginError(400, 'INVALID_REVERSE_PROXY', '设置代理密码时必须提供 AI Studio 反向代理地址。');
    }

    const model = requireCanonicalString(body.model, 'model', /^gemini-[a-z0-9][a-z0-9._-]*$/u);
    const region = source === 'vertexai'
        ? requireCanonicalString(body.vertexai_region, 'Vertex AI region', /^(?:global|[a-z0-9][a-z0-9-]*)$/u, 63) : undefined;
    const authMode = source === 'vertexai'
        ? requireCanonicalString(body.vertexai_auth_mode, 'Vertex AI authentication mode', /^(?:express|full)$/u, 16) : undefined;
    const tier = requireCanonicalString(body.tier, 'PayGo tier', /^(?:standard|flex|priority)$/u, 16);

    if (typeof body.stream !== 'boolean' || (body.paygoOnly !== undefined && typeof body.paygoOnly !== 'boolean')) {
        throw new PluginError(400, 'INVALID_PREPARE_REQUEST', 'stream 和 paygoOnly 必须是布尔值。');
    }
    if (body.paygoOnly === true) throw new PluginError(400, 'PAYGO_ONLY_REMOVED', '强制仅使用 PayGo 功能已移除，请刷新前端或移除旧选项。');
    // Recognize old protocol-2 clients, but reject before auth/tickets/upstream.
    if (tier === 'priority') throw new PluginError(400, 'PRIORITY_REMOVED', 'Priority 已移除，请刷新前端并使用 Standard 或 Flex。');
    if (source === 'vertexai' && tier === 'flex' && isGemini4Model(model)) {
        throw new PluginError(400, 'MODEL_UNSUPPORTED', 'Vertex AI Flex 不支持 Gemini 4 模型，请使用 Standard。');
    }
    if (source === 'vertexai' && tier === 'flex' && region !== 'global') {
        throw new PluginError(409, 'GLOBAL_REGION_REQUIRED', 'Flex 需要将 Vertex AI 区域设为 global。');
    }
    let expressProjectId;
    if (source === 'vertexai' && body.vertexai_express_project_id !== undefined && body.vertexai_express_project_id !== '') {
        expressProjectId = requireCanonicalString(
            body.vertexai_express_project_id,
            'Vertex AI Express project ID',
            /^[a-z0-9][a-z0-9-]*$/u,
            63,
        );
    }

    let secretId;
    if (body.secret_id !== undefined && body.secret_id !== null && body.secret_id !== '') {
        secretId = requireCanonicalString(body.secret_id, 'secret ID', /^[A-Za-z0-9_-]+$/u, 128);
    }

    const usageChatId = body.usageChatId === undefined || body.usageChatId === null || body.usageChatId === ''
        ? undefined : validateChatId(body.usageChatId);
    const usagePrice = validateUsagePrice(body.usagePrice);
    const worldInfoOrder = validateWorldInfoOrderPlan(body.worldInfoOrder);

    return Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        source,
        ...(reverseProxy ? { reverseProxy, proxyPassword } : {}),
        model,
        region,
        authMode,
        stream: body.stream,
        tier,
        paygoOnly: false, // Read-only compatibility value; never requests forced shared traffic.
        expressProjectId,
        secretId,
        usageChatId,
        usagePrice,
        ...(worldInfoOrder && usageChatId ? { worldInfoOrder } : {}),
        // Inspection is optional: malformed/unknown tokens must not reject generation.
        ...(typeof body.promptInspectorTicket === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(body.promptInspectorTicket) ? { promptInspectorTicket: body.promptInspectorTicket } : {}),
    });
}

module.exports = {
    AUTH_MODES,
    COMPATIBLE_ST_RANGE,
    PLUGIN_ID,
    PLUGIN_VERSION,
    PROTOCOL_VERSION,
    TIERS,
    validateChatId,
    validatePreparePayload,
    validateUsagePrice,
    validateWorldInfoOrderPlan,
};
