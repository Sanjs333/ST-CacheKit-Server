/* SPDX-License-Identifier: MPL-2.0 */
'use strict';
const { PluginError } = require('./errors.cjs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { BoundedBuffer } = require('./bounded-buffer.cjs');
const { validateBillingSettings } = require('./billing-store.cjs');
const { createBillingLabels } = require('./billing-labels.cjs');

const MAX_QUERY_BYTES = '100000000';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ROW_FIELDS = ['day', 'currency', 'grossCost', 'credits', 'netCost', 'lastExportTime', 'chatLabel', 'requestLabel'];
function validateBillingQuery(input = {}) {
    const invalid = () => { throw new PluginError(400, 'INVALID_BILLING_QUERY', '账单日期或关联标识无效，日期范围最多 31 天。'); };
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['startDate', 'endDate', 'chatId', 'requestId'].includes(key))) invalid();
    for (const key of ['startDate', 'endDate']) {
        if (typeof input[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input[key])) invalid();
        const date = new Date(input[key] + 'T00:00:00Z');
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input[key]) invalid();
    }
    const span = (Date.parse(input.endDate) - Date.parse(input.startDate)) / 86400000;
    if (!Number.isInteger(span) || span < 0 || span > 30) invalid();
    if (input.chatId !== undefined && (typeof input.chatId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.chatId))) invalid();
    if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !/^[a-z0-9_-]{1,63}$/.test(input.requestId))) invalid();
    return { ...input };
}

function buildBillingQuery(config, input, credentialProject) {
    const settings = validateBillingSettings(config), range = validateBillingQuery(input);
    const parameters = [
        { name: 'start_date', parameterType: { type: 'DATE' }, parameterValue: { value: range.startDate } },
        { name: 'end_date', parameterType: { type: 'DATE' }, parameterValue: { value: range.endDate } },
        { name: 'project_id', parameterType: { type: 'STRING' }, parameterValue: { value: settings.projectFilter || credentialProject } },
    ];
    if (range.chatId) parameters.push({ name: 'chat_label', parameterType: { type: 'STRING' }, parameterValue: { value: createBillingLabels(range.chatId, null, 'chat').st_cachekit_chat } });
    if (range.requestId) parameters.push({ name: 'request_label', parameterType: { type: 'STRING' }, parameterValue: { value: range.requestId } });
    // Query only the configured table; values are parameters, never SQL text.
    // Gross cost and credits are separate in Cloud Billing exports.
    const query = `SELECT
      CAST(DATE(usage_start_time, 'Asia/Shanghai') AS STRING) AS day,
      currency,
      SUM(cost) AS grossCost,
      SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS credits,
      SUM(cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS netCost,
      CAST(MAX(export_time) AS STRING) AS lastExportTime,
      (SELECT l.value FROM UNNEST(labels) AS l WHERE l.key = 'st_cachekit_chat' LIMIT 1) AS chatLabel,
      (SELECT l.value FROM UNNEST(labels) AS l WHERE l.key = 'st_cachekit_request' LIMIT 1) AS requestLabel
    FROM \`${settings.datasetProject}.${settings.dataset}.${settings.table}\`
    WHERE usage_start_time >= TIMESTAMP(@start_date, 'Asia/Shanghai')
      AND usage_start_time < TIMESTAMP(DATE_ADD(@end_date, INTERVAL 1 DAY), 'Asia/Shanghai')
      AND project.id = @project_id
      AND (LOWER(service.description) LIKE '%vertex%' OR LOWER(service.description) LIKE '%agent platform%')
      ${range.chatId ? "AND EXISTS (SELECT 1 FROM UNNEST(labels) l WHERE l.key = 'st_cachekit_chat' AND l.value = @chat_label)" : ''}
      ${range.requestId ? "AND EXISTS (SELECT 1 FROM UNNEST(labels) l WHERE l.key = 'st_cachekit_request' AND l.value = @request_label)" : ''}
    GROUP BY day, currency, chatLabel, requestLabel
    ORDER BY day DESC, chatLabel, requestLabel
    LIMIT 1000`;
    return { query, useLegacySql: false, parameterMode: 'NAMED', queryParameters: parameters, maximumBytesBilled: MAX_QUERY_BYTES, location: settings.location, timeoutMs: 1000, maxResults: 1000 };
}

function projectRows(data) {
    const invalid = () => { throw new PluginError(502, 'BILLING_QUERY_FAILED', '账单服务返回格式无效。'); };
    if (!data || typeof data !== 'object' || Array.isArray(data)
        || data.rows !== undefined && !Array.isArray(data.rows)
        || data.schema?.fields !== undefined && (!Array.isArray(data.schema.fields) || data.schema.fields.length > 128)) invalid();
    const fields = data.schema?.fields?.map(field => field?.name) ?? ROW_FIELDS;
    return (data.rows ?? []).slice(0, 1000).map(row => {
        if (!row || typeof row !== 'object' || !Array.isArray(row.f)) invalid();
        const projected = {};
        fields.forEach((key, index) => {
            if (!ROW_FIELDS.includes(key)) return;
            const value = row.f?.[index]?.v;
            if (['grossCost', 'credits', 'netCost'].includes(key)) {
                const number = typeof value === 'number' || typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
                projected[key] = Number.isFinite(number) ? number : null;
            }
            else projected[key] = typeof value === 'string' ? value.slice(0, 128) : null;
        });
        return projected;
    });
}

class BillingClient {
    constructor({ fetchImpl = globalThis.fetch, getAuthorization, now = Date.now } = {}) {
        Object.assign(this, { fetch: fetchImpl, getAuthorization, now });
        this.cache = new Map();
        this.pending = new Map();
    }
    async json(url, options, token, timeoutMs = 20000) {
        let response;
        try { response = await this.fetch(url, { ...options, headers: { Authorization: token, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' }); }
        catch { throw new PluginError(502, 'BILLING_UNAVAILABLE', '账单查询连接失败或超时，请稍后重试。'); }
        if (!response.ok) {
            try { await response.body?.cancel?.(); } catch { /* Reject without reading an error body. */ }
            response.body?.destroy?.();
            const messages = { 401: '服务账号认证失败。', 403: '服务账号缺少 BigQuery 查询或账单表读取权限，请配置 BigQuery Job User 与 Data Viewer。', 404: '账单表或数据集不存在，请先开启账单导出并检查表名。' };
            throw new PluginError(response.status === 403 ? 403 : 502, response.status === 403 ? 'BILLING_PERMISSION_REQUIRED' : 'BILLING_QUERY_FAILED', messages[response.status] || '账单查询失败，请检查配置或降低查询日期范围。');
        }
        const tooLarge = () => new PluginError(502, 'BILLING_RESPONSE_TOO_LARGE', '账单结果超过读取上限，请缩小日期范围。');
        if (Number(response.headers?.get?.('content-length')) > MAX_RESPONSE_BYTES) {
            try { await response.body?.cancel?.(); } catch { /* Do not retain a rejected result. */ }
            response.body?.destroy?.();
            throw tooLarge();
        }
        const bytes = new BoundedBuffer(MAX_RESPONSE_BYTES);
        try {
            if (response.body) for await (const chunk of response.body) {
                if (!bytes.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) throw tooLarge();
            }
        } catch (error) {
            if (error instanceof PluginError) throw error;
            throw new PluginError(502, 'BILLING_UNAVAILABLE', '账单结果读取失败或超时，请稍后重试。');
        }
        const text = bytes.toBuffer().toString('utf8');
        let data; try { data = JSON.parse(text); } catch { throw new PluginError(502, 'BILLING_QUERY_FAILED', '账单服务返回格式无效。'); }
        if (!data || typeof data !== 'object' || Array.isArray(data) || data.error || data.errors?.length) throw new PluginError(502, 'BILLING_QUERY_FAILED', '账单查询失败，请检查表结构、权限或查询范围。');
        return data;
    }
    async query(user, config, input) {
        const settings = validateBillingSettings(config), range = validateBillingQuery(input);
        if (!settings.enabled) throw new PluginError(409, 'BILLING_NOT_CONFIGURED', '请先配置并开启账单查询。');
        if (typeof user?.directories?.root !== 'string' || !user.directories.root) throw new PluginError(401, 'AUTHENTICATED_USER_REQUIRED', '请先登录酒馆用户账号。');
        let authorizationTimer;
        let credentials;
        try {
            credentials = await Promise.race([this.getAuthorization(user, settings.secretId), new Promise((_, reject) => {
                authorizationTimer = setTimeout(() => reject(new PluginError(504, 'BILLING_UNAVAILABLE', '账单认证超时，请稍后重试。')), 20000);
                authorizationTimer.unref?.();
            })]);
        } finally { clearTimeout(authorizationTimer); }
        if (!credentials || typeof credentials.projectId !== 'string'
            || !/^[a-z][a-z0-9-]{4,62}[a-z0-9]$/.test(credentials.projectId)
            || typeof credentials.authorization !== 'string' || !/^Bearer [^\x00-\x20\x7f]{1,16384}$/.test(credentials.authorization)) {
            throw new PluginError(400, 'BILLING_CREDENTIAL_UNAVAILABLE', '账单查询需要可用的 Vertex 服务账号凭证。');
        }
        const credentialIdentity = createHash('sha256').update(typeof credentials.credentialId === 'string' && credentials.credentialId
            ? credentials.credentialId : credentials.authorization).digest('hex');
        const key = JSON.stringify([path.resolve(user.directories.root), settings, range, credentials.projectId, credentialIdentity]);
        const cached = this.cache.get(key);
        if (cached && this.now() - cached.at < 60000) return { ...cached.result, rows: cached.result.rows.map(row => ({ ...row })), cached: true };
        if (this.pending.has(key)) {
            const result = await this.pending.get(key);
            return { ...result, rows: result.rows.map(row => ({ ...row })), cached: true };
        }
        if (this.pending.size >= 32) throw new PluginError(429, 'BILLING_QUERY_BUSY', '账单查询较多，请稍后重试。');
        const task = this.execute(settings, range, credentials);
        this.pending.set(key, task);
        try {
            const result = await task;
            this.cache.set(key, { at: this.now(), result });
            while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
            return { ...result, rows: result.rows.map(row => ({ ...row })) };
        } finally { this.pending.delete(key); }
    }
    async execute(settings, range, credentials) {
        const deadline = Date.now() + 30000;
        const read = (url, options) => {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new PluginError(504, 'BILLING_QUERY_PENDING', '账单查询仍在处理，请稍后重试。');
            return this.json(url, options, credentials.authorization, Math.min(20000, remaining));
        };
        const body = buildBillingQuery(settings, range, credentials.projectId);
        const base = 'https://bigquery.googleapis.com/bigquery/v2/projects/' + encodeURIComponent(settings.queryProject) + '/queries';
        let data = await read(base, { method: 'POST', body: JSON.stringify(body) });
        for (let attempt = 0; data.jobComplete === false && attempt < 3; attempt++) {
            const reference = data.jobReference;
            if (!reference?.jobId || !/^[A-Za-z0-9_-]{1,256}$/.test(reference.jobId)
                || reference.projectId !== undefined && reference.projectId !== settings.queryProject
                || reference.location !== undefined && (typeof reference.location !== 'string'
                    || !/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(reference.location)
                    || reference.location.toLowerCase() !== settings.location.toLowerCase())) {
                throw new PluginError(502, 'BILLING_QUERY_FAILED', '账单查询任务或数据集位置无效。');
            }
            data = await read(base + '/' + encodeURIComponent(reference.jobId) + '?location=' + encodeURIComponent(reference.location || settings.location) + '&timeoutMs=1000&maxResults=1000', { method: 'GET' });
        }
        if (data.jobComplete === false) throw new PluginError(504, 'BILLING_QUERY_PENDING', '账单查询仍在处理，请稍后重试。');
        if (data.jobComplete !== true) throw new PluginError(502, 'BILLING_QUERY_FAILED', '账单服务未返回完整查询结果。');
        return { ok: true, kind: 'billing-export', granularity: 'day', sourceGranularity: 'hour', reportingTimeZone: 'Asia/Shanghai', startDate: range.startDate, endDate: range.endDate, fetchedAt: new Date(this.now()).toISOString(), rows: projectRows(data), truncated: Boolean(data.pageToken) || (data.rows?.length ?? 0) >= 1000, linked: Boolean(range.chatId || range.requestId), note: '账单来源按小时记录，这里按北京时间的日期汇总；最多显示 1000 行，数据有延迟且可能后续调整。净费用包含导出表中的抵扣，旧请求没有标签时无法按聊天或请求匹配。' };
    }
}

module.exports = { BillingClient, buildBillingQuery, validateBillingQuery, projectRows, MAX_QUERY_BYTES, MAX_RESPONSE_BYTES };
