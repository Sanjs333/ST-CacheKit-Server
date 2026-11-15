/* SPDX-License-Identifier: MPL-2.0 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadStRuntime } = require('../src/st-runtime.cjs');
const { prepareGoogleTarget, validatePreparedGoogleTarget } = require('../src/target-policy.cjs');

const MODEL = 'gemini-4-carbon';
const HOSTS = new Map([
    ['us', 'aiplatform.us.rep.googleapis.com'],
    ['eu', 'aiplatform.eu.rep.googleapis.com'],
    ['global', 'aiplatform.googleapis.com'],
    ['us-central1', 'us-central1-aiplatform.googleapis.com'],
    ['europe-west4', 'europe-west4-aiplatform.googleapis.com'],
]);

async function createRuntime({ version = '1.16.0', hostConfig } = {}) {
    const hostCalls = [];
    const secretCalls = [];
    const readSecret = (directories, key, id) => {
        secretCalls.push({ directories, key, id });
        return key === 'service-account' ? '{"project_id":"test-project"}' : 'test-api-key';
    };
    const googleModule = {
        async getGoogleApiConfig(request, model, endpoint) {
            hostCalls.push(request);
            if (hostConfig) return hostConfig;
            const body = request.body;
            const host = body.vertexai_region === 'global' ? 'aiplatform.googleapis.com'
                : `${body.vertexai_region}-aiplatform.googleapis.com`;
            const baseUrl = `https://${host}/v1`;
            const projectId = body.vertexai_auth_mode === 'full' ? 'test-project' : body.vertexai_express_project_id;
            const prefix = projectId ? `/projects/${projectId}/locations/${body.vertexai_region}` : '';
            return {
                baseUrl,
                url: `${baseUrl}${prefix}/publishers/google/models/${model}:${endpoint}`,
                headers: body.vertexai_auth_mode === 'full' ? { Authorization: 'Bearer test-access-token' }
                    : { 'x-goog-api-key': 'test-api-key' },
                safetySettings: [],
            };
        },
        getProjectIdFromServiceAccount: account => account.project_id,
        generateJWTToken: async () => 'test-jwt',
        getAccessToken: async () => 'test-access-token',
    };
    const secretsModule = {
        SECRET_KEYS: { VERTEXAI: 'api-key', VERTEXAI_SERVICE_ACCOUNT: 'service-account' },
        readSecret,
        SecretManager: class {
            constructor(directories) { this.directories = directories; }
            readSecret(key, id) { return readSecret(this.directories, key, id); }
        },
    };
    const runtime = await loadStRuntime({
        readFile: async () => JSON.stringify({ name: 'sillytavern', version }),
        importModule: async specifier => {
            if (specifier.endsWith('/google.js')) return googleModule;
            if (specifier.endsWith('/secrets.js')) return secretsModule;
            throw new Error(`Unexpected import: ${specifier}`);
        },
    });
    return { runtime, hostCalls, secretCalls };
}

for (const selection of ['default', 'explicit', 'legacy-explicit']) {
    test(`${selection} credentials reach the correct Vertex endpoint and pass stream validation`, async () => {
        const { runtime, hostCalls, secretCalls } = await createRuntime({
            version: selection === 'legacy-explicit' ? '1.14.0' : '1.16.0',
        });
        for (const [region, hostname] of HOSTS) {
            for (const authMode of ['express', 'express-project', 'full']) {
                for (const stream of [false, true]) {
                    const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
                    const body = {
                        api: 'vertexai', vertexai_region: region,
                        vertexai_auth_mode: authMode === 'full' ? 'full' : 'express',
                        ...(authMode === 'express-project' ? { vertexai_express_project_id: 'test-project' } : {}),
                        ...(selection !== 'default' ? { secret_id: 'selected-secret' } : {}),
                    };
                    const directories = { root: 'test-user' };
                    const result = await runtime.getGoogleApiConfig({ body, user: { directories } }, MODEL, endpoint);
                    const target = new URL(result.url);
                    assert.equal(target.hostname, hostname, `${selection}/${region}/${authMode}/${endpoint}`);
                    assert.equal(target.pathname, `/v1${authMode === 'express' ? '' : `/projects/test-project/locations/${region}`}/publishers/google/models/${MODEL}:${endpoint}`);
                    assert.equal(result.headers[authMode === 'full' ? 'Authorization' : 'x-goog-api-key'],
                        authMode === 'full' ? 'Bearer test-access-token' : 'test-api-key');
                    if (result.baseUrl) assert.equal(new URL(result.baseUrl).hostname, hostname);
                    const config = { source: 'vertexai', model: MODEL, region, stream };
                    const prepared = prepareGoogleTarget(result.url, config);
                    assert.equal(validatePreparedGoogleTarget(prepared, config).hostname, hostname);
                    const betaTarget = new URL(prepared);
                    betaTarget.pathname = betaTarget.pathname.replace('/v1/', '/v1beta1/');
                    assert.equal(validatePreparedGoogleTarget(betaTarget.href, config).hostname, hostname);
                    assert.equal(betaTarget.search, stream ? '?alt=sse' : '');
                    if (selection !== 'default') {
                        assert.deepEqual(secretCalls.at(-1), {
                            directories, key: authMode === 'full' ? 'service-account' : 'api-key', id: 'selected-secret',
                        });
                    }
                }
            }
        }
        assert.equal(hostCalls.length, selection === 'default' ? 30 : 0);
        assert.equal(secretCalls.length, selection === 'default' ? 0 : 30);
    });
}

test('hosts with current multi-region endpoints preserve configuration and headers', async () => {
    for (const [region, hostname] of [...HOSTS].slice(0, 2)) {
        const hostConfig = {
            url: `https://${hostname}/v1/publishers/google/models/${MODEL}:generateContent`,
            baseUrl: `https://${hostname}/v1`,
            headers: { 'x-goog-api-key': 'test-api-key' }, safetySettings: [], apiName: 'Google Vertex AI',
        };
        const { runtime } = await createRuntime({ hostConfig });
        const result = await runtime.getGoogleApiConfig({ body: { api: 'vertexai', vertexai_region: region } }, MODEL, 'generateContent');
        assert.deepEqual(result, hostConfig);
        assert.equal(result.headers, hostConfig.headers);
    }
});

test('AI Studio and its reverse proxy preserve their host configuration', async () => {
    const hostConfig = { url: 'https://studio-proxy.example/v1beta/models/test:generateContent', headers: {} };
    const { runtime } = await createRuntime({ hostConfig });
    for (const reverseProxy of [undefined, 'https://studio-proxy.example']) {
        const result = await runtime.getGoogleApiConfig({ body: {
            api: 'makersuite', vertexai_region: 'us', reverse_proxy: reverseProxy,
            ...(reverseProxy ? { secret_id: 'selected-secret' } : {}),
        } }, MODEL, 'generateContent');
        assert.equal(result, hostConfig);
    }
});

test('multi-region compatibility still rejects unsafe host, scheme, credentials, path and query', async () => {
    const suffix = `/v1/publishers/google/models/${MODEL}:generateContent`;
    for (const region of ['us', 'eu']) {
        const validHost = HOSTS.get(region);
        const urls = [
            `https://${region}-aiplatform.googleapis.com.evil.example${suffix}`,
            `https://${region === 'us' ? HOSTS.get('eu') : HOSTS.get('us')}${suffix}`,
            `http://${region}-aiplatform.googleapis.com${suffix}`,
            `https://user:password@${region}-aiplatform.googleapis.com${suffix}`,
            `https://${region}-aiplatform.googleapis.com:8443${suffix}`,
            `https://${validHost}/v1/projects/test-project/locations/global/publishers/google/models/${MODEL}:generateContent`,
            `https://${validHost}${suffix}?key=unexpected`,
            `https://${validHost}${suffix}#unexpected`,
            'invalid-url',
        ];
        for (const url of urls) {
            const { runtime } = await createRuntime({ hostConfig: { url, headers: {} } });
            const result = await runtime.getGoogleApiConfig({ body: { api: 'vertexai', vertexai_region: region } }, MODEL, 'generateContent');
            assert.throws(() => prepareGoogleTarget(result.url, { source: 'vertexai', region, model: MODEL, stream: false }),
                { code: 'UNSAFE_GOOGLE_TARGET' }, url);
        }
        assert.throws(() => validatePreparedGoogleTarget(`https://${region}-aiplatform.googleapis.com${suffix}`,
            { source: 'vertexai', region, model: MODEL, stream: false }), { code: 'UNSAFE_GOOGLE_TARGET' });
    }
});
