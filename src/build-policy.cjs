/* Local preview update policy; SPDX-License-Identifier: MPL-2.0 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
function readBuildPolicy(root, fsModule = fs) {
    const marker = path.join(root, 'local-preview-build.json');
    if (!fsModule.existsSync(marker)) return Object.freeze({ distribution: 'upstream', upstreamUpdatesAllowed: true });
    let data;
    try {
        const stat = fsModule.lstatSync(marker);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid marker');
        data = JSON.parse(fsModule.readFileSync(marker, 'utf8'));
    } catch { return Object.freeze({ distribution: 'local-preview', upstreamUpdatesAllowed: false, markerValid: false }); }
    // Merely having this marker always disables upstream code replacement.
    // Corruption or changing a boolean must not accidentally enable updates.
    const valid = data?.version === 1 && data.allowUpstreamUpdates === false;
    const previewVersion = typeof data?.previewVersion === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(data.previewVersion) ? data.previewVersion : undefined;
    return Object.freeze({ distribution: 'local-preview', upstreamUpdatesAllowed: false, markerValid: valid,
        ...(previewVersion ? { previewVersion } : {}) });
}
module.exports = { readBuildPolicy };
