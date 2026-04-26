// Module-worker spawning, shared by the prover and the scanner pool.

import type { WorkerLike } from "./types.js";

/** Spawn an ES-module Worker from a URL. Browser / any DOM-Worker host. */
export function spawnModuleWorker(url: string | URL): WorkerLike {
    return new Worker(url, { type: "module" }) as unknown as WorkerLike;
}
