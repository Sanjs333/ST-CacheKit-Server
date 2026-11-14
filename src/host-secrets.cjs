/* Local ST 1.14 compatibility; SPDX-License-Identifier: MPL-2.0 */
'use strict';
const { PluginError } = require('./errors.cjs');

// ST 1.14/1.15's exported readSecret(directories, key) ignores a third ID
// argument. Its SecretManager.readSecret(key, id) is the actual by-ID API.
// Never fall back to the active credential when a specific ID was selected.
function createHostSecretReader({ secretsModule, legacy = false }) {
    if (typeof secretsModule?.readSecret !== 'function' || !secretsModule.SECRET_KEYS) {
        throw new PluginError(500, 'INCOMPATIBLE_SILLYTAVERN', '酒馆的密钥读取接口不可用。');
    }
    if (legacy && (typeof secretsModule.SecretManager !== 'function'
        || typeof secretsModule.SecretManager.prototype?.readSecret !== 'function')) {
        throw new PluginError(500, 'INCOMPATIBLE_HOST_SECRET_MANAGER', '当前酒馆版本缺少按 ID 读取密钥的接口，请更新酒馆。');
    }
    return function readHostSecret(directories, key, id = null) {
        const selected = id !== undefined && id !== null && id !== '';
        if (selected && (typeof id !== 'string' || id !== id.trim() || id.length > 256)) {
            throw new PluginError(400, 'EXPLICIT_SECRET_UNSUPPORTED', '所选密钥的 ID 无效。');
        }
        try {
            if (legacy && selected) return new secretsModule.SecretManager(directories).readSecret(key, id);
            return selected ? secretsModule.readSecret(directories, key, id) : secretsModule.readSecret(directories, key);
        } catch {
            throw new PluginError(400, 'EXPLICIT_SECRET_UNAVAILABLE', '无法读取酒馆保存的密钥。');
        }
    };
}
module.exports = { createHostSecretReader };
