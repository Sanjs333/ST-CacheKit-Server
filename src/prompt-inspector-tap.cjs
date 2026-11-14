/* Exact post-transform wire tap; observation is always fail-open.
 * SPDX-License-Identifier: MPL-2.0. */
'use strict';
const { Transform } = require('node:stream');
const { BoundedBuffer } = require('./bounded-buffer.cjs');
class PromptInspectorBodyTap extends Transform {
    constructor({ store, handle, metadata } = {}) {
        super(); this.store = store; this.handle = handle; this.metadata = metadata;
        this.total = 0; this.reserved = 0; this.reason = null;
        // Fixed blocks: object/allocation counts never depend on network chunking.
        this.buffer = new BoundedBuffer(Number.isSafeInteger(store?.maxBodyBytes) ? store.maxBodyBytes : 0, 16 * 1024);
        try { this.unregister = store.registerGoogleCapture(handle, () => this.discard('RAW_BODY_UNAVAILABLE')); }
        catch { this.reason = 'RAW_BODY_UNAVAILABLE'; }
        if (!this.unregister) this.reason = 'RAW_BODY_UNAVAILABLE';
    }
    discard(reason = this.reason) {
        this.reason = reason; this.buffer.blocks = []; this.buffer.size = 0;
        try { this.store.releaseCaptureBytes(this.reserved); } catch {}
        this.reserved = 0;
    }
    _transform(chunk, encoding, callback) {
        this.total += chunk.length;
        try {
            if (!this.reason && this.total > this.buffer.limit) this.discard('BODY_TOO_LARGE');
            if (!this.reason) {
                // Charge allocated capacity (including a partial last block), not
                // merely written bytes, against the store's global capture bound.
                const allocation = Math.min(this.buffer.limit, Math.ceil(this.total / this.buffer.blockSize) * this.buffer.blockSize);
                const additional = allocation - this.reserved;
                if (!this.store.reserveCaptureBytes(this.handle, additional)) this.discard('INSPECTOR_CAPACITY');
                else { this.reserved += additional; this.buffer.append(chunk); }
            }
        } catch { this.discard('RAW_BODY_UNAVAILABLE'); }
        callback(null, chunk); // NEVER rewrite or block the outgoing bytes.
    }
    _flush(callback) {
        try {
            const bytes = this.reason ? null : this.buffer.toBuffer();
            const reason = this.reason; this.discard(); this.unregister?.();
            this.store.captureGoogleBody(this.handle, bytes, { bodyBytes: this.total, reason }, this.metadata);
        } catch {}
        callback();
    }
    _destroy(error, callback) { this.discard(); try { this.unregister?.(); } catch {} callback(error); }
}
module.exports = { PromptInspectorBodyTap };
