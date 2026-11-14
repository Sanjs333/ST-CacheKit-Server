/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const { PluginError } = require('./errors.cjs');

const REQUEST_TYPE_HEADER = 'X-Vertex-AI-LLM-Request-Type';
const SHARED_REQUEST_TYPE_HEADER = 'X-Vertex-AI-LLM-Shared-Request-Type';
const SERVER_TIMEOUT_HEADER = 'X-Server-Timeout';

function buildPayGoHeaders({ tier, paygoOnly = false, source = 'vertexai' }) {
    if (paygoOnly === true) throw new PluginError(400, 'PAYGO_ONLY_REMOVED', '强制仅使用 PayGo 功能已移除，请刷新前端或移除旧选项。');
    if (tier === 'priority') throw new PluginError(400, 'PRIORITY_REMOVED', 'Priority 已移除，请使用 Standard 或 Flex。');
    if (!['standard', 'flex'].includes(tier) || typeof paygoOnly !== 'boolean'
        || !['vertexai', 'makersuite'].includes(source)
        || (source === 'makersuite' && (!['standard', 'flex'].includes(tier) || paygoOnly))) {
        throw new PluginError(500, 'INVALID_HEADER_POLICY', 'PayGo 请求头策略收到无效设置。');
    }

    const headers = {};
    if (source === 'vertexai' && tier === 'flex') {
        headers[SHARED_REQUEST_TYPE_HEADER] = tier;
    }
    if (tier === 'flex') {
        headers[SERVER_TIMEOUT_HEADER] = '1800';
    }
    return Object.freeze(headers);
}

module.exports = {
    REQUEST_TYPE_HEADER,
    SERVER_TIMEOUT_HEADER,
    SHARED_REQUEST_TYPE_HEADER,
    buildPayGoHeaders,
};
