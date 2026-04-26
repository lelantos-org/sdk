// Public surface of the `sync` domain — high-level sync engine, scanner,
// scanner worker pool + protocol.
//
// `./scanner-worker.ts` is NOT re-exported: it is the Worker bootstrap
// entrypoint for `WorkerPoolScanner`, published as the
// `@lelantos-org/sdk/scanner-worker` subpath export. Re-exporting it would
// force every consumer to resolve worker bootstrap glue at module load.

export * from "./scanner.js";
export * from "./scanner-worker-pool.js";
export * from "./scanner-worker-protocol.js";
export * from "./sync.js";
