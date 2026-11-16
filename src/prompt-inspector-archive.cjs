/* Rolling final-request evidence in the authenticated user's data directory.
 * SPDX-License-Identifier: MPL-2.0. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const HISTORY_LIMIT = 30;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const STATES = new Set(['dispatched', 'responded', 'failed', 'oversize']);
const matches = (record, query) => (query.ticket === undefined || query.ticket === record.id)
    && ['chatId', 'source', 'model'].every(key => query[key] === undefined || query[key] === record[key]);
const summary = record => Object.fromEntries(['id', 'chatId', 'source', 'model', 'sequence', 'state', 'complete',
    'capturedAt', 'dispatchAt', 'responseAt', 'errorCode', 'metadata'].filter(key => record[key] !== undefined)
    .map(key => [key, structuredClone(record[key])]));
const validRecord = record => record?.version === 1 && typeof record.id === 'string' && ID.test(record.id)
    && typeof record.chatId === 'string' && typeof record.source === 'string' && typeof record.model === 'string'
    && Number.isSafeInteger(record.sequence) && record.sequence > 0 && STATES.has(record.state)
    && typeof record.complete === 'boolean' && (record.rawRequest === null || typeof record.rawRequest === 'string')
    && (!record.complete || typeof record.rawRequest === 'string');

class PromptInspectorArchive {
    constructor({ rootDir, owner, maxEntries = HISTORY_LIMIT, maxRecordBytes = 8 * 1024 * 1024 } = {}) {
        if (typeof rootDir !== 'string' || !rootDir || !/^[a-f0-9]{64}$/u.test(owner ?? '')
            || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > HISTORY_LIMIT
            || !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) throw new TypeError('Invalid request history limits.');
        this.directory = path.join(path.resolve(rootDir), 'st-cachekit', 'prompt-history', owner);
        this.maxEntries = maxEntries; this.maxRecordBytes = maxRecordBytes; this.records = null;
    }
    file(id) {
        if (typeof id !== 'string' || !ID.test(id)) throw new TypeError('Invalid request history ID.');
        return path.join(this.directory, id + '.json');
    }
    ensureDirectory() {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        if (!fs.lstatSync(this.directory).isDirectory() || fs.lstatSync(this.directory).isSymbolicLink()) throw new Error('Invalid request history directory.');
    }
    readFile(id) {
        const filename = this.file(id), stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxRecordBytes) throw new Error('Invalid request history file.');
        const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (value?.version !== 1 || !validRecord(value.record) || value.record.id !== id) throw new Error('Invalid request history record.');
        return value.record;
    }
    load() {
        if (this.records) return;
        let manifest;
        try {
            const filename = path.join(this.directory, 'index.json'), stat = fs.lstatSync(filename);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('Invalid request history index.');
            manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
        } catch (error) {
            if (error.code !== 'ENOENT') return this.recover();
        }
        if (!manifest) {
            try { if (fs.readdirSync(this.directory).some(name => /^[A-Za-z0-9_-]{1,128}\.json$/u.test(name) && name !== 'index.json')) return this.recover(); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            this.records = []; return;
        }
        if (manifest.version !== 1 || !Array.isArray(manifest.records) || manifest.records.length > this.maxEntries
            || manifest.records.some(record => !ID.test(record?.id ?? '') || !Number.isSafeInteger(record.sequence) || record.sequence < 1)
            || new Set(manifest.records.map(record => record.id)).size !== manifest.records.length) return this.recover();
        const filenames = fs.readdirSync(this.directory).filter(name => name !== 'index.json' && /^[A-Za-z0-9_-]{1,128}\.json$/u.test(name));
        if (filenames.length !== manifest.records.length || filenames.some(name => !manifest.records.some(record => name === record.id + '.json'))) return this.recover();
        this.records = manifest.records;
        this.pruneTemporaryFiles();
    }
    recover() {
        const candidates = [];
        let names;
        try { names = fs.readdirSync(this.directory); } catch (error) { if (error.code === 'ENOENT') { this.records = []; return; } throw error; }
        for (const name of names) {
            if (name === 'index.json' || !/^[A-Za-z0-9_-]{1,128}\.json$/u.test(name)) continue;
            try { candidates.push(summary(this.readFile(name.slice(0, -5)))); } catch { /* Unreadable evidence cannot be advertised as complete. */ }
        }
        this.records = candidates.sort((a, b) => b.sequence - a.sequence).slice(0, this.maxEntries);
        this.ensureDirectory(); this.writeIndex(); this.prune();
        this.pruneTemporaryFiles();
    }
    atomicWrite(filename, bytes) {
        const temporary = path.join(this.directory, '.tmp-' + randomUUID());
        try { fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, filename); }
        finally { try { fs.unlinkSync(temporary); } catch {} }
    }
    writeIndex() { this.atomicWrite(path.join(this.directory, 'index.json'), JSON.stringify({ version: 1, records: this.records })); }
    pruneTemporaryFiles() {
        for (const name of fs.readdirSync(this.directory)) if (/^\.tmp-[a-f0-9-]{36}$/u.test(name)) fs.unlinkSync(path.join(this.directory, name));
    }
    prune() {
        const kept = new Set(this.records.map(record => record.id + '.json'));
        for (const name of fs.readdirSync(this.directory)) {
            if (name === 'index.json' || !/^[A-Za-z0-9_-]{1,128}\.json$/u.test(name) || kept.has(name)) continue;
            fs.unlinkSync(path.join(this.directory, name));
        }
    }
    maxSequence() { this.load(); return Math.max(0, ...this.records.map(record => record.sequence)); }
    save(record) {
        if (!validRecord(record)) return false;
        const bytes = JSON.stringify({ version: 1, record });
        if (Buffer.byteLength(bytes) > this.maxRecordBytes) return false;
        this.load(); this.ensureDirectory();
        const previous = this.records;
        this.atomicWrite(this.file(record.id), bytes);
        this.records = [summary(record), ...previous.filter(item => item.id !== record.id)]
            .sort((a, b) => b.sequence - a.sequence).slice(0, this.maxEntries);
        try { this.writeIndex(); } catch (error) { this.records = previous; throw error; }
        this.prune(); return true;
    }
    list(query = {}) { this.load(); return this.records.filter(record => matches(record, query)).map(record => structuredClone(record)); }
    read(query = {}) {
        const chosen = this.list(query)[0];
        if (!chosen) return null;
        try { return this.readFile(chosen.id); } catch { return null; }
    }
    remove(query = {}) {
        this.load();
        const removed = this.records.filter(record => matches(record, query));
        if (!removed.length) return;
        const previous = this.records;
        this.records = this.records.filter(record => !matches(record, query));
        try { this.writeIndex(); } catch (error) { this.records = previous; throw error; }
        for (const record of removed) { try { fs.unlinkSync(this.file(record.id)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    }
}

module.exports = { PromptInspectorArchive, HISTORY_LIMIT };
