/* SPDX-License-Identifier: MPL-2.0 */
'use strict';
const { requireAuthenticatedUser } = require('./admin-guard.cjs');
const { sendExpressError } = require('./errors.cjs');

function registerBillingRoutes(router, { billingStore, billingClient }) {
    const handle = fn => async (request, response) => {
        response.set?.('Cache-Control', 'no-store');
        try { requireAuthenticatedUser(request); return response.json(await fn(request)); }
        catch (error) { return sendExpressError(response, error); }
    };
    router.get('/billing/settings', handle(request => ({ ok: true, settings: billingStore.read(request.user) })));
    router.post('/billing/settings', handle(request => ({ ok: true, settings: billingStore.write(request.user, request.body) })));
    router.post('/billing/query', handle(request => billingClient.query(request.user, billingStore.read(request.user), request.body)));
}

module.exports = { registerBillingRoutes };
