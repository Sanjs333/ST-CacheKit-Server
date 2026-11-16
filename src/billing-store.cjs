/* SPDX-License-Identifier: MPL-2.0 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PluginError } = require('./errors.cjs');

const DEFAULT_BILLING_SETTINGS = Object.freeze({ version: 1, enabled: false, queryProject: '', datasetProject: '', dataset: '', table: '', projectFilter: '', location: 'US', secretId: '', labelMode: 'off' });
const PROJECT = /^[a-z][a-z0-9-]{4,62}[a-z0-9]$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;
const FIELDS = Object.keys(DEFAULT_BILLING_SETTINGS);

function validateBillingSettings(input) {
    const invalid = () => { throw new PluginError(400, 'INVALID_BILLING_SETTINGS', '账单设置无效，请检查项目、数据集、表名和关联方式。'); };
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !FIELDS.includes(key))) invalid();
    const settings = { ...DEFAULT_BILLING_SETTINGS, ...input, version: 1 };
    if (typeof settings.enabled !== 'boolean' || !['off', 'chat', 'request'].includes(settings.labelMode)) invalid();
    for (const key of ['queryProject', 'datasetProject', 'projectFilter']) if (typeof settings[key] !== 'string' || (settings[key] && !PROJECT.test(settings[key]))) invalid();
    for (const key of ['dataset', 'table']) if (typeof settings[key] !== 'string' || (settings[key] && !IDENTIFIER.test(settings[key]))) invalid();
    if (typeof settings.location !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(settings.location)) invalid();
    if (typeof settings.secretId !== 'string' || settings.secretId.length > 256 || /[\x00-\x20\x7f]/.test(settings.secretId)) invalid();
    if (settings.enabled && !['queryProject', 'dataset', 'table'].every(key => settings[key])) invalid();
    if (settings.enabled && !settings.datasetProject) settings.datasetProject = settings.queryProject;
    return settings;
}

class BillingStore {
    constructor({ fsModule = fs } = {}) { this.fs = fsModule; }
    file(user) {
        const root = user?.directories?.root;
        if (typeof root !== 'string' || !root) throw new PluginError(401, 'AUTHENTICATED_USER_REQUIRED', '请先登录酒馆用户账号。');
        return path.join(path.resolve(root), 'vertex-paygo', 'billing-settings.json');
    }
    read(user) {
        try { return validateBillingSettings(JSON.parse(this.fs.readFileSync(this.file(user), 'utf8'))); }
        catch (error) { if (error?.code === 'ENOENT') return { ...DEFAULT_BILLING_SETTINGS }; throw error; }
    }
    write(user, input) {
        const settings = validateBillingSettings(input), file = this.file(user);
        this.fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const temporary = file + '.' + randomUUID() + '.tmp';
        try {
            this.fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            this.fs.renameSync(temporary, file);
        } finally { try { this.fs.unlinkSync(temporary); } catch {} }
        return settings;
    }
}

module.exports = { BillingStore, DEFAULT_BILLING_SETTINGS, validateBillingSettings };
