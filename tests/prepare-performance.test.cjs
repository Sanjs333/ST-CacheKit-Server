const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { createPrepareHandler } = require('../src/prepare-route.cjs');
const { PROTOCOL_VERSION } = require('../src/protocol.cjs');

function fixture({ usageChatId = 'chat' } = {}) {
    const calls = { loads: 0, creates: 0, auth: 0, commits: [], releases: [], logs: [] };
    const request = {
        user: { profile: { handle: 'fixture-user' }, directories: { root: path.join(os.tmpdir(), 'cachekit-prepare-fixture') } },
        body: { protocolVersion: PROTOCOL_VERSION, chat_completion_source: 'makersuite', model: 'gemini-fixture',
            tier: 'standard', stream: true, ...(usageChatId ? { usageChatId } : {}) },
    };
    const response = {
        statusCode: 200,
        set() {},
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; },
    };
    const reservation = {};
    const usageStore = {
        async ensureLoaded() { calls.loads++; },
        create() { calls.creates++; return { file: 'fixture-ledger', id: 'fixture-usage' }; },
    };
    const handler = createPrepareHandler({
        stRuntime: { async getGoogleApiConfig(_request, model, endpoint) {
            calls.auth++;
            return { url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:${endpoint}`,
                headers: { 'x-goog-api-key': 'fixture-key' } };
        } },
        ticketStore: {
            reserve() { return reservation; },
            release(value) { calls.releases.push(value); },
            commit(value, data) {
                calls.commits.push({ reservation: value, data });
                return { ticket: 'fixture-ticket', proxySecret: 'fixture-secret', expiresAt: Date.now() + 60000 };
            },
        },
        loopbackTransport: { baseUrl: 'http://127.0.0.1:12345' },
        logStore: { server(_level, event) { calls.logs.push(event); } },
        usageStore,
    });
    return { request, response, calls, usageStore, run: () => handler(request, response) };
}

test('an inaccessible usage ledger does not prevent preparing generation', async () => {
    const setup = fixture();
    setup.usageStore.ensureLoaded = async () => { setup.calls.loads++; throw Object.assign(new Error('Fixture ledger is inaccessible'), { code: 'EACCES' }); };
    await setup.run();
    assert.equal(setup.response.statusCode, 200);
    assert.equal(setup.response.body.ok, true);
    assert.equal(setup.response.body.usageId, null);
    assert.equal(setup.calls.loads, 1); assert.equal(setup.calls.creates, 0);
    assert.equal(setup.calls.commits.length, 1);
    assert.equal(setup.calls.commits[0].data.usageReference, null);
    assert.ok(setup.calls.logs.includes('usage_ledger_create_failed'));
    assert.equal(setup.calls.logs.includes('prepare_failed'), false);
});

test('requests without usage recording do not load the ledger', async () => {
    const setup = fixture({ usageChatId: null });
    await setup.run();
    assert.equal(setup.response.body.ok, true);
    assert.equal(setup.calls.loads, 0); assert.equal(setup.calls.creates, 0);
    assert.equal(setup.calls.commits.length, 1);
});

for (const mode of ['request-aborted', 'response-destroyed', 'request-aborted-with-load-error']) {
    test(`disconnect during ledger loading releases the ticket without dispatch: ${mode}`, async () => {
        const setup = fixture();
        setup.usageStore.ensureLoaded = async () => {
            setup.calls.loads++;
            await Promise.resolve();
            if (mode === 'response-destroyed') setup.response.destroyed = true;
            else setup.request.aborted = true;
            if (mode === 'request-aborted-with-load-error') throw Object.assign(new Error('Fixture read failed after disconnect'), { code: 'EIO' });
        };
        await setup.run();
        assert.equal(setup.calls.loads, 1);
        assert.equal(setup.calls.creates, 0);
        assert.equal(setup.calls.commits.length, 0);
        assert.equal(setup.calls.releases.length, 1);
        assert.equal(setup.response.body, undefined);
    });
}
