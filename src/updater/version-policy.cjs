/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const { PluginError } = require('../errors.cjs');
const { inferUpdateChannel } = require('../../vendor/update-channel.cjs');

// Share CLI version selection; filesystem changes are delegated.

// One deliberate difference from the CLI: when a tag does not look like
// vMAJOR.MINOR.PATCH, Git's own version sort would still order it. This module
// refuses instead, because silently selecting a different release than the CLI
// is worse than a clear error.

const METADATA_SCHEMA = 1;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/u;

const MODE_TAG = 'tag';
const MODE_COMMIT = 'commit';
const ACTION_UPDATE = 'update';
const ACTION_UNCHANGED = 'unchanged';
const ACTION_KEEP_AHEAD = 'keep-ahead';

function fail(code, message) {
    throw new PluginError(409, code, message);
}

function validateRef(ref, label) {
    if (typeof ref !== 'string' || ref.length === 0 || !REF_PATTERN.test(ref) || ref.includes('..')) {
        fail('UPDATER_INVALID_REF', `${label}名称无效。`);
    }
    return ref;
}

function parseTag(name) {
    const match = typeof name === 'string' ? TAG_PATTERN.exec(name) : null;
    if (!match) return null;
    return Object.freeze({
        core: Object.freeze([Number(match[1]), Number(match[2]), Number(match[3])]),
        prerelease: match[4] ?? null,
    });
}

// Mirrors `git -c versionsort.suffix=- tag --sort=version:refname`: the core
// versions compare numerically, and a release outranks its own prereleases.
function compareTags(left, right) {
    const a = parseTag(left);
    const b = parseTag(right);
    if (!a || !b) {
        fail(
            'UPDATER_UNKNOWN_TAG_SHAPE',
            `无法比较 ${left} 和 ${right}：更新器仅支持 v主版本.次版本.修订版本 格式的标签。`,
        );
    }
    for (let index = 0; index < a.core.length; index += 1) {
        if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
    }
    if (a.prerelease === b.prerelease) return 0;
    if (a.prerelease === null) return 1;
    if (b.prerelease === null) return -1;
    const leftParts = a.prerelease.match(/\d+|\D+/gu);
    const rightParts = b.prerelease.match(/\d+|\D+/gu);
    for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index++) {
        const x = leftParts[index];
        const y = rightParts[index];
        if (x === y) continue;
        if (/^\d+$/u.test(x) && /^\d+$/u.test(y)) {
            if (x.startsWith('0') || y.startsWith('0')) {
                if (x.startsWith('0') !== y.startsWith('0')) return x.startsWith('0') ? -1 : 1;
                if (x.startsWith(y) || y.startsWith(x)) return y.length - x.length;
                return x < y ? -1 : 1;
            }
            if (BigInt(x) !== BigInt(y)) return BigInt(x) < BigInt(y) ? -1 : 1;
        }
        return x < y ? -1 : 1;
    }
    return leftParts.length - rightParts.length;
}

// Describe uses a date-ordered walk and ranks candidates by uncovered commits.
// Preserve its bounded search, including stopping when all tag targets have
// been found: computing full graph distances can select a different commit.
// Behaviour is checked against native Git in updater-version-policy-git.test.
function selectReleaseTag({ tags, branchHistory, branchHead = branchHistory?.[0]?.oid }) {
    if (!Array.isArray(branchHistory) || branchHistory.length === 0) {
        fail('UPDATER_NO_HISTORY', '需要读取所选分支的提交历史，才能确定最新发布标签。');
    }
    const byCommit = new Map();
    for (const entry of Array.isArray(tags) ? tags : []) {
        if (!entry || typeof entry.name !== 'string' || typeof entry.commit !== 'string') continue;
        if (!byCommit.has(entry.commit)) byCommit.set(entry.commit, []);
        byCommit.get(entry.commit).push(entry.name);
    }
    if (byCommit.size === 0) fail('UPDATER_NO_TAG', '所选分支没有可用的发布标签。');
    const graph = new Map(branchHistory.map(entry => [entry.oid, entry]));
    const queued = new Set([branchHead]);
    const coverage = new Map();
    const queue = [branchHead];
    const candidates = [];
    let walked = 0;
    while (queue.length > 0) {
        if (candidates.length === Math.min(10, byCommit.size)) break;
        const oid = queue.shift();
        const entry = graph.get(oid);
        if (!entry || !Array.isArray(entry.parents)) fail('UPDATER_NO_HISTORY', '准备的提交历史不完整。');
        const coveredBy = coverage.get(oid) ?? new Set();
        if (byCommit.has(oid)) {
            const candidate = { oid, distance: walked };
            candidates.push(candidate);
            coveredBy.add(candidate);
            if (oid === branchHead) break;
        }
        for (const candidate of candidates) {
            if (!coveredBy.has(candidate)) candidate.distance++;
        }
        walked++;
        for (const parent of entry.parents) {
            if (!graph.has(parent)) fail('UPDATER_NO_HISTORY', '准备的提交历史不完整。');
            const inherited = coverage.get(parent) ?? new Set();
            for (const candidate of coveredBy) inherited.add(candidate);
            coverage.set(parent, inherited);
            if (!queued.has(parent)) {
                queued.add(parent);
                queue.push(parent);
            }
        }
        queue.sort((a, b) => graph.get(b).timestamp - graph.get(a).timestamp);
    }
    if (candidates.length === 0) fail('UPDATER_NO_REACHABLE_TAG', '所选分支的提交历史中找不到发布标签。');
    candidates.sort((a, b) => a.distance - b.distance);
    const commit = candidates[0].oid;
    const names = byCommit.get(commit);
    if (names.some(name => !parseTag(name))) {
        fail('UPDATER_UNKNOWN_TAG_SHAPE', '所选提交的标签不符合支持的 v主版本.次版本.修订版本 格式。');
    }
    return Object.freeze({ name: names.slice().sort(compareTags).at(-1), commit });
}

function readMetadata(metadata) {
    if (metadata === undefined || metadata === null) return null;
    if (typeof metadata !== 'object' || Array.isArray(metadata) || metadata.schema !== METADATA_SCHEMA) {
        fail('UPDATER_INVALID_METADATA', '插件更新记录的格式版本不是 1。');
    }
    if (metadata.mode !== MODE_TAG && metadata.mode !== MODE_COMMIT) {
        fail('UPDATER_INVALID_METADATA', '插件更新记录包含未知的更新方式。');
    }
    return Object.freeze({
        schema: METADATA_SCHEMA,
        branch: validateRef(metadata.branch, '跟踪分支'),
        mode: metadata.mode,
        tag: metadata.tag === null || metadata.tag === undefined ? null : validateRef(metadata.tag, '标签'),
        commit: typeof metadata.commit === 'string' ? metadata.commit : null,
    });
}

// An installation made by the host UI has no updater metadata yet, so the
// channel is inferred the same way the CLI infers it.
function inferChannel({ symbolicBranch = null, metadata = undefined, headTags = [], defaultBranch = 'main' }) {
    validateRef(defaultBranch, '默认分支');
    const stored = readMetadata(metadata);
    if (symbolicBranch !== null) validateRef(symbolicBranch, '分支');
    const channel = inferUpdateChannel({
        symbolicBranch,
        recordedBranch: stored?.branch,
        recordedTag: stored?.tag,
        headTag: Array.isArray(headTags) ? headTags[0] : null,
        defaultBranch,
    });
    if (channel) return channel;
    fail(
        'UPDATER_CHANNEL_UNKNOWN',
        '当前安装未记录更新渠道，请运行一次安装器以记录渠道后重试。',
    );
}

async function planUpdate({
    installedHead,
    installedBranch = null,
    dirtyTrackedCount = 0,
    channel,
    metadata = undefined,
    target,
    branchHead,
    isAncestor,
}) {
    if (typeof installedHead !== 'string' || installedHead.length === 0) {
        fail('UPDATER_NOT_INSTALLED', '未找到此组件已安装的 Git 版本。');
    }
    if (typeof branchHead !== 'string' || branchHead.length === 0) {
        fail('UPDATER_NO_BRANCH_HEAD', '所选分支没有可用的最新提交。');
    }
    if (!target || typeof target.commit !== 'string' || (channel?.mode === MODE_TAG && typeof target.name !== 'string')) {
        fail('UPDATER_NO_TARGET', '更新器未能确定目标版本。');
    }
    if (typeof isAncestor !== 'function') {
        throw new TypeError('isAncestor is required.');
    }
    if (!channel || typeof channel.branch !== 'string' || typeof channel.mode !== 'string') {
        fail('UPDATER_CHANNEL_UNKNOWN', '更新渠道未知。');
    }

    if (dirtyTrackedCount > 0) {
        fail(
            'UPDATER_LOCAL_CHANGES',
            `有 ${dirtyTrackedCount} 个文件存在本地改动或未纳入版本控制。请先备份，再使用安装器的 --replace-modified 选项替换。`,
        );
    }
    if (!await isAncestor(installedHead, branchHead)) {
        fail(
            'UPDATER_LOCAL_COMMITS',
            '已安装副本包含所选分支之外的提交，请使用安装器的 --replace-modified 选项备份并替换。',
        );
    }

    const stored = readMetadata(metadata);
    const sameChannel = Boolean(stored)
        && stored.branch === channel.branch
        && stored.mode === channel.mode
        && stored.tag === (channel.mode === MODE_TAG ? target.name : null);

    if (!await isAncestor(installedHead, target.commit)) {
        // The installed revision is not behind the tag. On the same tag channel
        // a revision ahead of the newest tag is kept, because the project never
        // downgrades on its own.
        const trackingBranch = installedBranch || stored?.branch || channel.branch;
        if (channel.mode === MODE_TAG && trackingBranch === channel.branch && await isAncestor(target.commit, installedHead)) {
            return Object.freeze({
                action: ACTION_KEEP_AHEAD,
                tag: target.name,
                commit: target.commit,
                reason: 'installed-revision-is-newer-than-the-newest-release-tag',
            });
        }
        fail(
            'UPDATER_OLDER_OR_DIVERGENT',
            `所选版本 ${target.name} 早于已安装版本，或与其提交历史不一致。请使用安装器的 --replace-modified 选项替换。`,
        );
    }

    const channelUnchanged = installedBranch === (channel.mode === MODE_TAG ? null : channel.branch);
    if (installedHead === target.commit && channelUnchanged && sameChannel && dirtyTrackedCount === 0) {
        return Object.freeze({
            action: ACTION_UNCHANGED,
            tag: target.name,
            commit: target.commit,
            reason: 'already-at-the-selected-release',
        });
    }

    return Object.freeze({
        action: ACTION_UPDATE,
        tag: channel.mode === MODE_TAG ? target.name : null,
        commit: target.commit,
        branch: channel.branch,
        mode: channel.mode,
    });
}

module.exports = {
    ACTION_KEEP_AHEAD,
    ACTION_UNCHANGED,
    ACTION_UPDATE,
    METADATA_SCHEMA,
    MODE_COMMIT,
    MODE_TAG,
    compareTags,
    inferChannel,
    parseTag,
    planUpdate,
    readMetadata,
    selectReleaseTag,
    validateRef,
};
