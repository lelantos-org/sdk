// Which JS runtime this is, and what it can do.
//
// Single home for environment probes, so the wallet and the prover cannot
// disagree about where they are running; such a mismatch fails far from the
// predicate that causes it.
//
// Tier 0 leaf: importable from anywhere, imports nothing.

/**
 * True on Node, and on Node-compatible runtimes that populate
 * `process.versions`.
 *
 * A constant rather than a function: the answer cannot change within a realm.
 */
export const IS_NODE = typeof process !== "undefined" && !!process.versions?.node;

/**
 * Specifier for `node:fs/promises`, held as a string so bundlers targeting the
 * browser do not try to resolve it. Always paired with a dynamic `import()`
 * behind an {@link IS_NODE} guard.
 */
export const NODE_FS_PROMISES = "node:fs/promises";

/** Specifier for `node:worker_threads`, held as a string like {@link NODE_FS_PROMISES}. */
export const NODE_WORKER_THREADS = "node:worker_threads";

/**
 * Where to look for things the caller did not locate explicitly — artifacts,
 * key material, an RPC transport.
 *
 * Both `window` and `document` are checked because a Node process with a DOM
 * shim has one but not the other. A worker has neither and reports `"node"`,
 * as intended: a worker resolves paths the way its parent does.
 */
export function detectRuntime(): "node" | "browser" {
    const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
    return isBrowser ? "browser" : "node";
}

/** `navigator.hardwareConcurrency`, or 4 where the platform does not report it. */
export function hardwareConcurrency(): number {
    return (
        (globalThis as { navigator?: { hardwareConcurrency?: number | undefined } }).navigator
            ?.hardwareConcurrency ?? 4
    );
}

/**
 * Whether `SharedArrayBuffer` is usable, i.e. the page sent COOP+COEP.
 *
 * Read through a cast because `crossOriginIsolated` is absent from the Node lib
 * types. Gates rayon's thread pool and the wasm prover's multi-threaded path;
 * both fall back to single-threaded when it is false.
 */
export function isCrossOriginIsolated(): boolean {
    return (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}
