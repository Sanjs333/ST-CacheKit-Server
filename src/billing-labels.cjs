/* SPDX-License-Identifier: MPL-2.0 */
'use strict';
const { createHash } = require('node:crypto');
const LABEL_KEYS = ['st_cachekit_chat', 'st_cachekit_request'];

function sanitizeBillingLabels(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const labels = {};
    for (const key of LABEL_KEYS) {
        if (typeof input[key] === 'string' && /^[a-z0-9_-]{1,63}$/.test(input[key])) labels[key] = input[key];
    }
    return Object.keys(labels).length ? labels : undefined;
}

function createBillingLabels(chatId, requestId, mode = 'chat') {
    if (typeof chatId !== 'string' || !chatId || !['chat', 'request'].includes(mode)) return undefined;
    const labels = { st_cachekit_chat: createHash('sha256').update(chatId).digest('hex').slice(0, 32) };
    if (mode === 'request' && typeof requestId === 'string' && /^[a-z0-9_-]{1,63}$/.test(requestId)) labels.st_cachekit_request = requestId;
    return labels;
}

function applyBillingLabels(body, input) {
    const reserved = sanitizeBillingLabels(input);
    if (!reserved || !body || typeof body !== 'object') return body;
    const existing = body.labels && typeof body.labels === 'object' && !Array.isArray(body.labels) ? body.labels : {};
    // Google accepts at most 64 labels. Existing non-reserved labels keep order.
    const available = 64 - Object.keys(reserved).length;
    body.labels = { ...Object.fromEntries(Object.entries(existing).filter(([key]) => !LABEL_KEYS.includes(key)).slice(0, available)), ...reserved };
    return body;
}

module.exports = { LABEL_KEYS, sanitizeBillingLabels, createBillingLabels, applyBillingLabels };
