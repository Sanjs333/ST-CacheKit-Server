/* Local ST 1.14 compatibility; SPDX-License-Identifier: MPL-2.0 */
'use strict';
const { PluginError } = require('./errors.cjs');

// ST 1.14/1.15's exported readSecret(directories, key) ignores a third ID
// argument. Its SecretManager.readSecret(key, id) is the actual by-ID API.
// Never fall back to the active credential when a specific ID was selected.
function createHostSecretReader({ secretsModule, legacy = false }) {
    if (typeof secretsModule?.readSecret !== 'function' || !secretsModule.SECRET_KEYS) {
        throw new PluginError(500, 'INCOMPATIBLE_SILLYTAVERN', 'The host secret reader is unavailable.');
    }
    if (legacy && (typeof secretsModule.SecretManager !== 'function'
        || typeof secretsModule.SecretManager.prototype?.readSecret !== 'function')) {
        throw new PluginError(500, 'INCOMPATIBLE_HOST_SECRET_MANAGER', 'This legacy host lacks the required by-ID SecretManager interface.');
    }
    return function readHostSecret(directories, key, id = null) {
        const selected = id !== undefined && id !== null && id !== '';
        if (selected && (typeof id !== 'string' || id !== id.trim() || id.length > 256)) {
            throw new PluginError(400, 'EXPLICIT_SECRET_UNSUPPORTED', 'The selected credential ID is invalid.');
        }
        try {
            if (legacy && selected) return new secretsModule.SecretManager(directories).readSecret(key, id);
            return selected ? secretsModule.readSecret(directories, key, id) : secretsModule.readSecret(directories, key);
        } catch {
            throw new PluginError(400, 'EXPLICIT_SECRET_UNAVAILABLE', 'The host credential could not be read.');
        }
    };
}
module.exports = { createHostSecretReader };
