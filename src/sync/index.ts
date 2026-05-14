// Public surface of the `sync` domain — high-level sync engine, scanner,
// scanner worker pool + protocol.
//
// `./scanner-worker.ts` is intentionally NOT re-exported from this barrel.
// It is the dedicated-Worker bootstrap entrypoint for `WorkerPoolScanner`
// and is published as the separate `@lelantos-org/sdk/scanner-worker`
// subpath export. Re-exporting it here would force every consumer to
// resolve worker bootstrap glue at module load even when scanning lives
// on the main thread.

export * from "./scanner.js";
export * from "./scanner-worker-pool.js";
export * from "./scanner-worker-protocol.js";
export * from "./sync.js";
// `scanner-worker.ts` is the worker bootstrap entrypoint — published as a
// separate package export, intentionally NOT re-exported from the barrel.
