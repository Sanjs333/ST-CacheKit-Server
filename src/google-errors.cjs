/* SPDX-License-Identifier: MPL-2.0 */
'use strict';

const MAX_GOOGLE_ERROR_BYTES = 64 * 1024;
const MAX_GOOGLE_ERROR_MESSAGE_CHARS = 500;
const GOOGLE_ERROR_TAG = /^[A-Z][A-Z0-9_]{0,127}$/u;

function sanitizeGoogleErrorMessage(value) {
    if (typeof value !== 'string') return undefined;
    const text = value.slice(0, MAX_GOOGLE_ERROR_BYTES)
        .replace(/AIza[0-9A-Za-z_-]+/gu, '[redacted]')
        .replace(/ya29\.[0-9A-Za-z._-]+/gu, '[redacted]')
        .replace(/\b(Bearer\s+)[0-9A-Za-z._~+/-]+=*/giu, '$1[redacted]')
        .replace(/((?:[?&]key|api[_-]?key|x-goog-api-key|access_token|refresh_token|password|authorization)["']?\s*[:=]\s*["']?)[^\s"'&,;<>]+/giu, '$1[redacted]')
        .replace(/\s+/gu, ' ').trim();
    if (!text) return undefined;
    return text.length > MAX_GOOGLE_ERROR_MESSAGE_CHARS
        ? text.slice(0, MAX_GOOGLE_ERROR_MESSAGE_CHARS - 1) + '…' : text;
}

function sanitizeGoogleErrorDetails(input) {
    const details = {};
    if (Number.isSafeInteger(input?.upstreamStatus) && input.upstreamStatus >= 100 && input.upstreamStatus <= 599) {
        details.upstreamStatus = input.upstreamStatus;
    }
    for (const key of ['googleStatus', 'googleReason']) {
        if (typeof input?.[key] === 'string' && GOOGLE_ERROR_TAG.test(input[key])) details[key] = input[key];
    }
    const message = sanitizeGoogleErrorMessage(input?.upstreamMessage);
    if (message) details.upstreamMessage = message;
    return details;
}

function googleErrorDetails(status, error) {
    // Only Google's typed ErrorInfo reason is diagnostic evidence. Do not copy
    // arbitrary metadata, request contents or credentials into shared logs.
    const info = Array.isArray(error?.details) ? error.details.find(detail =>
        detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo'
        && typeof detail.reason === 'string' && GOOGLE_ERROR_TAG.test(detail.reason)) : undefined;
    return sanitizeGoogleErrorDetails({
        upstreamStatus: status, googleStatus: error?.status,
        googleReason: info?.reason, upstreamMessage: error?.message,
    });
}

function parseGoogleError(bytes) {
    try {
        const parsed = JSON.parse(bytes.toString('utf8'));
        return (Array.isArray(parsed) ? parsed[0] : parsed)?.error;
    } catch { return undefined; }
}

module.exports = { MAX_GOOGLE_ERROR_BYTES, MAX_GOOGLE_ERROR_MESSAGE_CHARS,
    sanitizeGoogleErrorMessage, sanitizeGoogleErrorDetails, googleErrorDetails, parseGoogleError };
