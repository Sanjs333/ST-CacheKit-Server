/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const { createLoopbackTransport } = require('./src/loopback-server.cjs');
const { createNativeRelay } = require('./src/native-relay.cjs');
const { LogStore, describeError } = require('./src/log-store.cjs');
const { PLUGIN_ID } = require('./src/protocol.cjs');
const { registerRoutes } = require('./src/routes.cjs');
const { createUpdater } = require('./src/updater/index.cjs');
const { loadStRuntime } = require('./src/st-runtime.cjs');
const { TicketStore } = require('./src/ticket-store.cjs');
const { UsageStore } = require('./src/usage-store.cjs');
const { BillingStore } = require('./src/billing-store.cjs');
const { BillingClient } = require('./src/billing-client.cjs');
const { PromptInspectorStore } = require('./src/prompt-inspector-store.cjs');
const { readBuildPolicy } = require('./src/build-policy.cjs');

const info = Object.freeze({
    id: PLUGIN_ID,
    name: '提示词缓存优化（服务端）',
    description: '为提示词缓存优化提供 Gemini 请求转发、用量记录与最终发送观测。',
});

let activeState;

async function init(router) {
    if (activeState) throw new Error('提示词缓存优化服务端插件已初始化。');

    const logStore = new LogStore({ rootDir: process.cwd() });
    logStore.server('info', 'plugin_initializing');
    let ticketStore;
    let loopbackTransport;
    let nativeTicketStore;
    let nativeRelay;
    const usageStore = new UsageStore({ onCleanupError: error => logStore.server('warn', 'usage_ledger_cleanup_failed', describeError(error)) });
    const promptInspectorStore = new PromptInspectorStore({ getCapability: () => nativeRelay?.available === true });
    try {
        const stRuntime = await loadStRuntime();
        const billingStore = new BillingStore();
        const billingClient = new BillingClient({ getAuthorization: (user, secretId) => stRuntime.getBillingAuthorization(user, secretId) });
        // Component paths and repositories remain lazy until an admin check.
        const buildPolicy = readBuildPolicy(__dirname);
        const updater = buildPolicy.upstreamUpdatesAllowed ? createUpdater({ logStore }) : undefined;
        logStore.server('info', 'host_runtime_loaded', {
            hostName: stRuntime.hostName,
            hostVersion: stRuntime.stVersion,
        });
        ticketStore = new TicketStore();
        loopbackTransport = createLoopbackTransport({ ticketStore, logStore, usageStore, promptInspectorStore });
        await loopbackTransport.start();
        nativeTicketStore = new TicketStore();
        nativeRelay = createNativeRelay({ ticketStore: nativeTicketStore, promptInspectorStore });
        try { await nativeRelay.start(); }
        catch {
            // Optional native inspection must not disable Google generation or
            // the rest of this ordinary server plugin.
            nativeTicketStore.close();
            logStore.server('warn', 'native_relay_unavailable');
        }
        registerRoutes(router, { stRuntime, ticketStore, loopbackTransport, logStore, usageStore, updater, buildPolicy,
            nativeTicketStore, nativeRelay, promptInspectorStore, billingStore, billingClient });
        activeState = { ticketStore, loopbackTransport, nativeTicketStore, nativeRelay, logStore, usageStore, promptInspectorStore };
        logStore.server('info', 'plugin_ready', {
            hostName: stRuntime.hostName,
            hostVersion: stRuntime.stVersion,
        });
    } catch (error) {
        promptInspectorStore.close();
        logStore.server('error', 'plugin_initialization_failed', describeError(error));
        try {
            ticketStore?.close();
            nativeTicketStore?.close();
            try { await loopbackTransport?.close(); }
            finally { await nativeRelay?.close(); }
        } catch (cleanupError) {
            logStore.server('error', 'plugin_initialization_cleanup_failed', describeError(cleanupError));
        } finally {
            await usageStore.close();
            logStore.close();
        }
        throw error;
    }
}

async function exit() {
    const state = activeState;
    activeState = undefined;
    if (!state) return;
    state.promptInspectorStore.close();
    state.logStore.server('info', 'plugin_stopping');
    state.ticketStore.close();
    state.nativeTicketStore?.close();
    try {
        try { await state.loopbackTransport.close(); }
        finally { await state.nativeRelay?.close(); }
        state.logStore.server('info', 'plugin_stopped');
    } catch (error) {
        state.logStore.server('error', 'plugin_shutdown_failed', describeError(error));
        throw error;
    } finally {
        await state.usageStore.close();
        state.logStore.close();
    }
}

module.exports = { info, init, exit };
