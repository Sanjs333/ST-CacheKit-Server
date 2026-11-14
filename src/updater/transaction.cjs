/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PluginError } = require('../errors.cjs');
const { resolveWithinHost } = require('./locations.cjs');

// Use same-filesystem staging and a transaction lock. Keep backup metadata for rollback.

// The plugin replaces its own directory while the host is running. Renaming a
// directory that contains loaded modules works on Linux and Android; Windows
// refuses to rename a file that is still open, and such a failure surfaces as a
// failed activation with the backup intact rather than as a silent partial
// state.

const LOCK_NAME = '.paygo-install.lock';
const BACKUP_ROOT = '.paygo-install-backups';
const STAGE_PREFIX = '.paygo-install-stage-';
const RESTORE_FILE = 'restore.json';

function acquireLock(rootDir) {
    const lock = path.join(rootDir, LOCK_NAME);
    try {
        fs.mkdirSync(lock);
    } catch (error) {
        if (error?.code === 'EEXIST') {
            throw new PluginError(
                409,
                'UPDATER_BUSY',
                `已有安装或更新任务正在运行，或上一次任务遗留了 ${LOCK_NAME} 目录。确认没有安装任务运行后，移除该目录再重试。`,
                { cause: error },
            );
        }
        throw new PluginError(500, 'UPDATER_LOCK_FAILED', `无法创建更新锁：${error?.message ?? error}`, { cause: error });
    }
    return lock;
}

function releaseLock(lock) {
    try {
        fs.rmdirSync(lock);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

function createStaging(rootDir) {
    const directory = fs.mkdtempSync(path.join(rootDir, STAGE_PREFIX));
    fs.chmodSync(directory, 0o700);
    return directory;
}

function removePath(target) {
    fs.rmSync(target, { recursive: true, force: true });
}

function assertManaged(rootDir, target) {
    resolveWithinHost(rootDir, target);
}

// A backup directory holds the previous contents plus the record needed to put
// them back by hand. Only components that actually change are recorded, so a
// single-component update does not promise to restore the other one.
function createBackup(rootDir, entries) {
    const base = path.join(rootDir, BACKUP_ROOT);
    assertManaged(rootDir, base);
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const backup = fs.mkdtempSync(path.join(base, `${stamp}-`));
    fs.chmodSync(backup, 0o700);
    const record = {
        host: rootDir,
        createdBy: 'st-cachekit-server panel updater',
        components: entries.map(entry => ({
            name: entry.name,
            target: entry.target,
            existed: fs.existsSync(entry.target),
            changed: true,
            staged: entry.staged,
        })),
    };
    fs.writeFileSync(path.join(backup, RESTORE_FILE), `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return backup;
}

// Moves every target aside, then puts the prepared copy in its place. A failure
// at any point leaves enough state for rollback to undo what has happened.
function activate({ rootDir, backup, entries }) {
    const activated = [];
    try {
        assertManaged(rootDir, backup);
        for (const entry of entries) {
            assertManaged(rootDir, entry.target);
            assertManaged(rootDir, entry.staged);
        }
        for (const entry of entries) {
            fs.mkdirSync(path.dirname(entry.target), { recursive: true });
            const state = { entry, saved: path.join(backup, entry.name), moved: false, activated: false };
            activated.push(state);
            if (fs.existsSync(entry.target)) {
                fs.renameSync(entry.target, state.saved);
                state.moved = true;
            }
            fs.renameSync(entry.staged, entry.target);
            state.activated = true;
        }
        return activated;
    } catch (error) {
        const recoveryErrors = rollback(activated);
        const suffix = recoveryErrors.length > 0
            ? `自动回滚未能完成：${recoveryErrors.join('; ')}。请从 ${backup} 恢复。`
            : `原有文件已从 ${backup} 恢复。`;
        throw new PluginError(
            500,
            'UPDATER_ACTIVATION_FAILED',
            `更新启用失败：${error?.message ?? error}。${suffix}`,
            { cause: error },
        );
    }
}

function rollback(activated) {
    const errors = [];
    for (const state of [...activated].reverse()) {
        const { entry } = state;
        try {
            if (state.activated) removePath(entry.target);
            if (state.moved) fs.renameSync(state.saved, entry.target);
        } catch (error) {
            errors.push(`${entry.name}: ${error?.message ?? error}`);
        }
    }
    return errors;
}

module.exports = {
    BACKUP_ROOT,
    LOCK_NAME,
    RESTORE_FILE,
    STAGE_PREFIX,
    acquireLock,
    activate,
    assertManaged,
    createBackup,
    createStaging,
    releaseLock,
    removePath,
    rollback,
};
