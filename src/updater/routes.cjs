/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const { sendExpressError, PluginError } = require('../errors.cjs');
const { requireAdministrator } = require('../admin-guard.cjs');

// A check answers what the components are and what they would become. It writes
// nothing, so it is safe to repeat. Starting an update answers immediately and
// keeps working in the background: a host restart or a client timeout must not
// abort a replacement that already moved files, and the panel polls for the
// outcome instead.

const UPDATE_FORBIDDEN = Object.freeze({
    code: 'UPDATER_ACCESS_FORBIDDEN',
    message: '更新提示词缓存优化组件需要管理员权限。',
});

function createCheckUpdateHandler({ updater, buildPolicy }) {
    return async function checkUpdateHandler(request, response) {
        response.set?.('Cache-Control', 'no-store');
        try {
            requireAdministrator(request, UPDATE_FORBIDDEN);
            if (buildPolicy?.upstreamUpdatesAllowed === false) throw new PluginError(409, 'LOCAL_PREVIEW_UPDATES_DISABLED', '此本地预览版本需要通过对应的本地构建更新。');
            const report = await updater.check();
            return response.json({ ok: true, ...report });
        } catch (error) {
            return sendExpressError(response, error);
        }
    };
}

function createStartUpdateHandler({ updater, buildPolicy }) {
    return function startUpdateHandler(request, response) {
        response.set?.('Cache-Control', 'no-store');
        try {
            requireAdministrator(request, UPDATE_FORBIDDEN);
            if (buildPolicy?.upstreamUpdatesAllowed === false) throw new PluginError(409, 'LOCAL_PREVIEW_UPDATES_DISABLED', '此本地预览版本需要通过对应的本地构建更新。');
            updater.start();
            return response.status(202).json({ ok: true, started: true });
        } catch (error) {
            return sendExpressError(response, error);
        }
    };
}

function createUpdateStatusHandler({ updater, buildPolicy }) {
    return function updateStatusHandler(request, response) {
        response.set?.('Cache-Control', 'no-store');
        try {
            requireAdministrator(request, UPDATE_FORBIDDEN);
            if (buildPolicy?.upstreamUpdatesAllowed === false) throw new PluginError(409, 'LOCAL_PREVIEW_UPDATES_DISABLED', '此本地预览版本需要通过对应的本地构建更新。');
            return response.json({ ok: true, ...updater.status() });
        } catch (error) {
            return sendExpressError(response, error);
        }
    };
}

module.exports = {
    UPDATE_FORBIDDEN,
    createCheckUpdateHandler,
    createStartUpdateHandler,
    createUpdateStatusHandler,
};
