/* SPDX-License-Identifier: MPL-2.0 */
'use strict';

function getVertexApiHostname(region) {
    if (region === 'global') return 'aiplatform.googleapis.com';
    if (region === 'us' || region === 'eu') return `aiplatform.${region}.rep.googleapis.com`;
    return `${region}-aiplatform.googleapis.com`;
}

function normalizeVertexApiUrl(rawUrl, region) {
    if (region !== 'us' && region !== 'eu') return rawUrl;
    let target;
    try {
        target = new URL(rawUrl);
    } catch {
        // Keep invalid targets intact for the target policy to reject.
        return rawUrl;
    }
    // Older hosts construct multi-region endpoints like regional endpoints.
    // Only repair that exact hostname; the target policy validates the rest.
    if (target.hostname !== `${region}-aiplatform.googleapis.com`) return rawUrl;
    target.hostname = getVertexApiHostname(region);
    return target.toString();
}

module.exports = { getVertexApiHostname, normalizeVertexApiUrl };
