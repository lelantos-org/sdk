// Which JS runtime this is, and what it can do.
//
// One home for the environment probes, because the alternative is what this
// module replaced: `IS_NODE` declared twice, `detectRuntime` written out twice
// with identical bodies, and `crossOriginIsolated` read two different ways in
// two files. Each copy was correct in isolation; the risk is drift, and a
// wallet that disagrees with its own prover about where it is running fails in
// ways that point nowhere near the predicate that caused it.
//
// Tier 0, and a leaf — importable from anywhere, imports nothing.

/**
 * True on Node, and on Node-compatible runtimes that populate
 * `process.versions`.
 *
 * A constant rather than a function: the answer cannot change within a realm,
 * and the module-eval cost is a `typeof` check.
 */
export const IS_NODE = typeof process !== "undefined" && !!process.versions?.node;

/**
 * Specifier for `node:fs/promises`, held as a string so bundlers targeting the
 * browser do not try to resolve it. Always paired with a dynamic `import()`
 * behind an {@link IS_NODE} guard.
 */
export const NODE_FS_PROMISES = "node:fs/promises";

/**
 * Where to look for things the caller did not locate explicitly — artifacts,
 * key material, an RPC transport.
 *
 * Both `window` and `document` are checked because a Node process with a DOM
 * shim installed has one but not the other. A worker has neither and reports
 * `"node"`, which is what its callers want: a worker resolves paths the way
 * its parent does.
 */
export function detectRuntime(): "node" | "browser" {
    const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
    return isBrowser ? "browser" : "node";
}

/**
 * Whether `SharedArrayBuffer` is usable, i.e. the page sent COOP+COEP.
 *
 * Read through a cast because `crossOriginIsolated` is absent from the Node
 * lib types, so a direct `globalThis.crossOriginIsolated` compiles in one
 * build target and not the other. Gates rayon's thread pool and the wasm
 * prover's multi-threaded path; both fall back to single-threaded rather than
 * failing when it is false.
 */
export function isCrossOriginIsolated(): boolean {
    return (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}
