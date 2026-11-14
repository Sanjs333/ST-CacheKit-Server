'use strict';

const { PluginError, sendExpressError } = require('./errors.cjs');
const { validateChatId } = require('./protocol.cjs');

function createUsageHandler({ usageStore }) {
    return function usageHandler(request, response) {
        try {
            if (!request.user?.directories?.root) {
                throw new PluginError(401, 'AUTHENTICATED_USER_REQUIRED', '请先登录 SillyTavern 用户账号。');
            }
            const chatId = validateChatId(request.query?.chatId);
            response.set?.('Cache-Control', 'no-store');
            const previewFlag = request.query?.includeRequestPreviews;
            if (previewFlag !== undefined && !['0', '1'].includes(previewFlag)) throw new PluginError(400, 'INVALID_USAGE_PAGE', '请求结构预览的选择参数无效。');
            const includePreviews = previewFlag === '1';
            const latestRaw = request.query?.latest;
            let latest;
            if (latestRaw !== undefined) {
                if (!includePreviews || typeof latestRaw !== 'string' || !/^(?:[1-9]|[1-4][0-9]|50)$/.test(latestRaw)
                    || request.query?.cursor !== undefined || request.query?.limit !== undefined) throw new PluginError(400, 'INVALID_USAGE_PAGE', '最近请求预览的分页参数无效。');
                latest = Number(latestRaw);
                if (typeof usageStore.listLatest !== 'function') throw new PluginError(409, 'REQUEST_PREVIEW_FEATURE_UNAVAILABLE', '当前后端不支持读取指定数量的最近请求预览，请更新后端。');
            }
            const page = latest !== undefined ? usageStore.listLatest(request.user, chatId, latest) : usageStore.list(request.user, chatId, {
                cursor: request.query?.cursor,
                limit: request.query?.limit,
            });
            if (!page) throw new PluginError(400, 'INVALID_USAGE_PAGE', '用量记录的分页游标或数量限制无效。');
            const records = includePreviews ? page.records : page.records.map(record => {
                // Cost/message snapshots must stay small and must not export
                // structural diagnostics merely because they query usage.
                const { googleRequests, googleRequestCount, ...costRecord } = record;
                return costRecord;
            });
            return response.json({ ok: true, ...page, records });
        } catch (error) {
            return sendExpressError(response, error);
        }
    };
}

module.exports = { createUsageHandler };
