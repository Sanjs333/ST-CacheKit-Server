/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const {
    COMPATIBLE_ST_RANGE,
    PLUGIN_ID,
    PLUGIN_VERSION,
    PROTOCOL_VERSION,
} = require('./protocol.cjs');
const { sendExpressError } = require('./errors.cjs');
const { registerNativeRelayRoutes } = require('./native-relay.cjs');
const { createClientLogHandler, createReadLogsHandler } = require('./log-routes.cjs');
const { createPrepareHandler } = require('./prepare-route.cjs');
const { createUsageHandler } = require('./usage-route.cjs');
const { createNativeGeminiHandler } = require('./native-gemini.cjs');
const {
    createCheckUpdateHandler,
    createStartUpdateHandler,
    createUpdateStatusHandler,
} = require('./updater/routes.cjs');

function registerPromptInspectorRoutes(router, store) {
    const handle = fn => (request, response) => {
        response.set?.('Cache-Control', 'no-store');
        response.set?.('Pragma', 'no-cache');
        try { return response.json(fn(request)); }
        catch (error) { return sendExpressError(response, error); }
    };
    router.post('/prompt-inspector', handle(request => store.prepare(request)));
    router.get('/prompt-inspector', handle(request => store.read(request)));
    router.delete('/prompt-inspector', handle(request => store.read(request, true)));
}

function registerRoutes(router, dependencies) {
    if (dependencies.promptInspectorStore) registerPromptInspectorRoutes(router, dependencies.promptInspectorStore);
    registerNativeRelayRoutes(router, dependencies);
    // Compatibility response for older clients. No host-source observer is
    // registered, so this retired receipt API cannot claim final-send evidence.
    const unavailableNativeOrder = (_request, response) => {
        response.set?.('Cache-Control', 'no-store');
        return response.status(503).json({ ok: false, code: 'NATIVE_ORDER_UNAVAILABLE', nativeOrderReceipts: false, receipt: null });
    };
    router.post('/native-order', unavailableNativeOrder);
    router.get('/native-order', unavailableNativeOrder);
    router.delete('/native-order', unavailableNativeOrder);
    router.get('/health', (request, response) => {
        response.set?.('Cache-Control', 'no-store');
        const isAdmin = request.user?.profile?.admin === true;
        response.json({
            ok: true,
            status: 'ok',
            pluginId: PLUGIN_ID,
            pluginVersion: PLUGIN_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            transport: 'loopback-http',
            ...(dependencies.buildPolicy ? { distribution: dependencies.buildPolicy } : {}),
            sillyTavern: {
                version: dependencies.stRuntime.stVersion,
                compatibleRange: COMPATIBLE_ST_RANGE,
                ...(dependencies.stRuntime.compatibility ? { compatibility: dependencies.stRuntime.compatibility } : {}),
            },
            capabilities: {
                logs: isAdmin,
                clientLogging: isAdmin,
                usage: true,
                promptInspector: dependencies.promptInspectorStore?.capabilities() ?? { version: 1, available: false,
                    api: false, nativeWire: false, nativeRelay: false, googleWire: false, requiresHostPatch: false,
                    pluginWireSources: [], supportedSources: [], sourceTrace: 'frontend-supplied', privacyMode: 'memory-only' },
                nativeOrderReceipts: false,
                requestPreviews: typeof dependencies.usageStore?.captureGoogleRequest === 'function',
                nativeGemini4: Boolean(dependencies.loopbackTransport),
                // Absent means the backend predates the panel updater; false
                // means the caller is not an administrator.
                updater: isAdmin && Boolean(dependencies.updater) && dependencies.buildPolicy?.upstreamUpdatesAllowed !== false,
            },
        });
    });
    router.get('/logs', createReadLogsHandler(dependencies));
    router.get('/usage', createUsageHandler(dependencies));
    router.get('/update', createCheckUpdateHandler(dependencies));
    router.get('/update/status', createUpdateStatusHandler(dependencies));
    router.post('/logs/client', createClientLogHandler(dependencies));
    router.post('/prepare', createPrepareHandler(dependencies));
    if (dependencies.loopbackTransport) {
        router.post('/native-gemini/generate', createNativeGeminiHandler({
            runtime: dependencies.stRuntime,
            loopbackTransport: dependencies.loopbackTransport,
        }));
    }
    router.post('/update', createStartUpdateHandler(dependencies));
    router.use('/rejected', (_request, response) => response.status(503).json({
        error: true,
        code: 'PAYGO_REQUEST_BLOCKED',
        message: 'The 提示词缓存优化 request was blocked before proxy preparation completed.',
    }));
}

module.exports = { registerRoutes, registerPromptInspectorRoutes };
