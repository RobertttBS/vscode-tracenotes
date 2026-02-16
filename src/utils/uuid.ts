/**
 * Generates a UUIDv4 safely across both Desktop (Node.js) and Web (Browser/Worker) VS Code extension hosts.
 */
export function generateIsomorphicUUID(): string {
    // 1. Try global Web Crypto API (Standard in Web Extensions & Node 19+)
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }

    // 2. Try Node.js native crypto module (Desktop Extensions on older Node)
    // We use typeof require to prevent Webpack/esbuild from throwing errors when compiling for the web
    if (typeof require !== 'undefined') {
        try {
            // Use dynamic require so bundlers don't try to polyfill it for the web worker
            const nodeCrypto = require('crypto');
            if (nodeCrypto.randomUUID) {
                return nodeCrypto.randomUUID();
            }
        } catch (e) {
            // Ignore module resolution errors and fall through to the manual generator
        }
    }

    // 3. Fallback: Standard Math.random() UUIDv4 implementation
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
