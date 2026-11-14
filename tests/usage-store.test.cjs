const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');
const { UsageStore, ledgerPathForUser } = require('../src/usage-store.cjs');
const { createUsageHandler } = require('../src/usage-route.cjs');

const user = { directories: { root: path.resolve(os.tmpdir(), 'cachekit-memory-fixture') } };
const details = { chatId: 'chat', source: 'makersuite', model: 'fixture', tier: 'standard', stream: true };
function memoryStore(rows = []) {
    let reads = 0, streams = 0, appends = 0, directories = 0; const written = [];
    const store = new UsageStore({ fsModule: {
        mkdirSync() { directories++; }, appendFileSync(_file, text) { appends++; written.push(...text.trim().split('\n').map(JSON.parse)); },
        readFileSync(file) { reads++; return file === ledgerPathForUser(user) ? rows.map(JSON.stringify).join('\n') : ''; },
        createReadStream(file) { streams++; return Readable.from([file === ledgerPathForUser(user) ? rows.map(JSON.stringify).join('\n') + '\n{"partial":' : '']); },
    } });
    return { store, written, reads: () => reads, streams: () => streams, appends: () => appends, directories: () => directories };
}

test('async ledger loading is shared, skips corrupt rows and publishes the complete index', async () => {
    const rows = Array.from({ length: 5000 }, (_, index) => ({ id: 'r-' + index, chatId: index % 2 ? 'other' : 'chat', status: 'complete' }));
    rows.push({ ...rows[0], status: 'incomplete' });
    const fixture = memoryStore(rows);
    await Promise.all(Array.from({ length: 12 }, () => fixture.store.ensureLoaded(user)));
    assert.equal(fixture.streams(), 1); assert.equal(fixture.reads(), 0);
    const records = fixture.store.list(user, 'chat');
    assert.equal(records.length, 2500);
    assert.equal(records[0].status, 'incomplete');
    assert.deepEqual(fixture.store.listLatest(user, 'chat', 2).records.map(record => record.id), ['r-4996', 'r-4998']);
    assert.equal(fixture.reads(), 0);
});

test('a missing ledger loads normally and subsequent writes survive a process restart', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cachekit-usage-test-'));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const localUser = { directories: { root } }, first = new UsageStore();
    await first.ensureLoaded(localUser);
    const reference = first.create(localUser, details);
    first.update(reference, { status: 'complete', usage: { promptTokenCount: 42 } });
    const second = new UsageStore(); await second.ensureLoaded(localUser);
    assert.equal(second.list(localUser, 'chat')[0].usage.promptTokenCount, 42);
    assert.equal(fs.readFileSync(ledgerPathForUser(localUser), 'utf8').trim().split('\n').length, 2);
});

test('ID lookup isolates chats/users and excludes previews before cloning cost records', async () => {
    let previewClones = 0;
    const fixture = memoryStore([{ id: 'a', chatId: 'chat', status: 'complete' }, { id: 'b', chatId: 'other', status: 'complete' }]);
    await fixture.store.ensureLoaded(user);
    fixture.store.indexes.get(ledgerPathForUser(user)).get('a').googleRequests = [{ toJSON() { previewClones++; return { body: 'diagnostic' }; } }];
    assert.deepEqual(fixture.store.listByIds(user, 'chat', ['a', 'b', 'missing']), { records: [{ id: 'a', chatId: 'chat', status: 'complete' }], lookup: true });
    assert.equal(previewClones, 0);
    assert.equal(fixture.store.list(user, 'chat', { limit: 200, includeRequestPreviews: false }).records.length, 1);
    assert.equal(previewClones, 0);
    assert.equal(fixture.store.listByIds(user, 'chat', ['a'], { includeRequestPreviews: true }).records[0].googleRequests.length, 1);
    assert.equal(previewClones, 1);
    assert.deepEqual(fixture.store.listByIds({ directories: { root: path.join(user.directories.root, 'another-user') } }, 'chat', ['a']).records, []);
    assert.notEqual(fixture.store.indexes.get(ledgerPathForUser(user)), fixture.store.indexes.get(ledgerPathForUser({ directories: { root: path.join(user.directories.root, 'another-user') } })));
});

test('pagination keeps a stable snapshot while new records arrive and updates retain order', async () => {
    const fixture = memoryStore(Array.from({ length: 7 }, (_, index) => ({ id: 'r-' + index, chatId: 'chat', status: 'complete' })));
    await fixture.store.ensureLoaded(user);
    const first = fixture.store.list(user, 'chat', { limit: 3 });
    const reference = fixture.store.create(user, details);
    fixture.store.update(reference, { status: 'complete', usage: { promptTokenCount: 10 } });
    const second = fixture.store.list(user, 'chat', { limit: 3, cursor: first.nextCursor });
    const third = fixture.store.list(user, 'chat', { limit: 3, cursor: second.nextCursor });
    assert.deepEqual([...first.records, ...second.records, ...third.records].map(record => record.id), Array.from({ length: 7 }, (_, index) => 'r-' + index));
    assert.equal(third.nextCursor, undefined);
    assert.equal(fixture.store.listLatest(user, 'chat', 1).records[0].id, reference.id);
    assert.equal(fixture.store.listByIds(user, 'chat', [reference.id]).records[0].usage.promptTokenCount, 10);
});

test('restart recovery and timeout recovery are persisted once and active usage is retained', async () => {
    const fixture = memoryStore([{ id: 'old', chatId: 'chat', status: 'pending', createdAt: new Date().toISOString() }]);
    await fixture.store.ensureLoaded(user);
    assert.equal(fixture.store.list(user, 'chat')[0].errorCode, 'PROCESS_RESTARTED');
    const reference = fixture.store.create(user, details);
    assert.equal(fixture.store.listByIds(user, 'chat', [reference.id]).records[0].status, 'pending');
    fixture.store.now = () => Date.now() + 40 * 60_000;
    assert.equal(fixture.store.listByIds(user, 'chat', [reference.id]).records[0].errorCode, 'USAGE_CAPTURE_TIMEOUT');
    fixture.store.list(user, 'chat');
    assert.equal(fixture.written.filter(record => record.id === 'old').length, 1);
    assert.equal(fixture.written.filter(record => record.id === reference.id).length, 2);
});

test('large restart recovery batches disk writes and retries after an append failure', async () => {
    const fixture = memoryStore(Array.from({ length: 2500 }, (_, index) => ({ id: 'old-' + index, chatId: 'chat', status: 'pending' })));
    await fixture.store.ensureLoaded(user);
    const append = fixture.store.fs.appendFileSync;
    fixture.store.fs.appendFileSync = () => { throw Object.assign(new Error('disk unavailable'), { code: 'EIO' }); };
    assert.throws(() => fixture.store.list(user, 'chat'), { code: 'EIO' });
    fixture.store.fs.appendFileSync = append;
    const records = fixture.store.list(user, 'chat');
    assert.equal(records.length, 2500);
    assert.ok(records.every(record => record.status === 'incomplete' && record.errorCode === 'PROCESS_RESTARTED'));
    assert.equal(fixture.appends(), 3); assert.equal(fixture.directories(), 1);
    fixture.store.list(user, 'chat'); assert.equal(fixture.appends(), 3);
});

test('usage route waits for the async index and validates targeted queries', async () => {
    const fixture = memoryStore([{ id: 'a', chatId: 'chat', status: 'complete' }]);
    const handler = createUsageHandler({ usageStore: fixture.store });
    const invoke = async query => {
        let result, status = 200;
        await handler({ user, query }, { set() {}, status(value) { status = value; return this; }, json(value) { result = value; return this; } });
        return { status, result };
    };
    const valid = await invoke({ chatId: 'chat', ids: 'a,a' });
    assert.equal(valid.status, 200); assert.equal(valid.result.lookup, true); assert.equal(valid.result.records.length, 1);
    assert.equal(fixture.reads(), 0);
    for (const query of [{ ids: '' }, { ids: 'a,bad id' }, { ids: 'a', cursor: 'next' }, { ids: Array.from({ length: 101 }, (_, index) => 'r-' + index).join(',') }]) {
        assert.equal((await invoke({ chatId: 'chat', ...query })).status, 400);
    }
});
