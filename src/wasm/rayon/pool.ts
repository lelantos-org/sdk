// Rayon thread-pool bring-up for `wasm-bindgen-rayon` modules.
//
// Both paths degrade to single-threaded rather than failing: rayon is a
// throughput optimisation, so a slow proof beats no proof. Every degradation
// is logged with its cause, on both paths.

import { withTimeout } from "../../core/async.js";
import { envProverThreads } from "../../log/env.js";
import { getLogger } from "../../log/logger.js";
import { installNodeRayonWorker } from "./node-worker.js";

const NODE_OS = "node:os";

/** rayon spins up N OS threads and mmaps a shared heap; 10s is generous. */
const INIT_TIMEOUT_MS = 10_000;

const log = getLogger("lelantos:wasm:rayon");

export interface RayonModule {
    initThreadPool?: ((n: number) => Promise<unknown>) | undefined;
}

export interface RayonInitOpts {
    /** Caller-supplied override; `null` means "use default". */
    threadCount: number | null;
    /** Tag identifying the module in log records (e.g. "WasmProver"). */
    label: string;
}

/** Why the pool ended up single-threaded, or how many threads it got. */
export type RayonOutcome =
    | { threads: number }
    | { threads: 1; reason: "unsupported" | "not-isolated" | "requested" | "failed" };

function singleThreaded(
    label: string,
    reason: "unsupported" | "not-isolated" | "requested" | "failed",
    detail: string,
    err?: unknown,
): RayonOutcome {
    log.warn(`rayon unavailable — running single-threaded: ${detail}`, { label, reason, err });
    return { threads: 1, reason };
}

export async function initBrowserThreadPool(
    mod: RayonModule,
    opts: RayonInitOpts,
): Promise<RayonOutcome> {
    if (!mod.initThreadPool) {
        return singleThreaded(opts.label, "unsupported", "module exposes no initThreadPool");
    }

    // Needs `crossOriginIsolated` (COOP+COEP). Without it SharedArrayBuffer
    // is unavailable and rayon falls back to the calling thread.
    const coi = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    if (!coi) {
        return singleThreaded(
            opts.label,
            "not-isolated",
            "crossOriginIsolated=false; set COOP=same-origin and COEP=require-corp on the " +
                "page (and on the worker) to enable rayon",
        );
    }

    const hw =
        (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
            ?.hardwareConcurrency ?? 4;
    const n = opts.threadCount ?? Math.max(2, hw);
    if (n <= 1) {
        return singleThreaded(opts.label, "requested", `thread count ${n} was requested`);
    }

    return startPool(mod, n, opts.label, { hardwareConcurrency: hw });
}

export async function initNodeThreadPool(
    mod: RayonModule,
    nodePkgUrl: string,
    opts: RayonInitOpts,
): Promise<RayonOutcome> {
    if (!mod.initThreadPool) {
        return singleThreaded(opts.label, "unsupported", "module exposes no initThreadPool");
    }

    const n = opts.threadCount ?? envProverThreads() ?? (await defaultThreadCount());
    if (n <= 1) {
        return singleThreaded(opts.label, "requested", `thread count ${n} was requested`);
    }

    try {
        await installNodeRayonWorker(nodePkgUrl);
    } catch (err) {
        return singleThreaded(opts.label, "failed", "could not install the Node worker shim", err);
    }
    return startPool(mod, n, opts.label, {});
}

async function startPool(
    mod: RayonModule,
    n: number,
    label: string,
    fields: Record<string, unknown>,
): Promise<RayonOutcome> {
    const t0 = performance.now();
    try {
        // Shared `withTimeout`, which clears its timer on success — a bare
        // Promise.race would leave one pending and hold the Node event loop
        // open after init completes.
        await withTimeout(
            mod.initThreadPool!(n),
            INIT_TIMEOUT_MS,
            () => new Error(`initThreadPool timed out after ${INIT_TIMEOUT_MS / 1000}s`),
        );
    } catch (err) {
        return singleThreaded(label, "failed", "initThreadPool rejected", err);
    }
    log.info("rayon thread pool ready", {
        label,
        threads: n,
        ms: Math.round(performance.now() - t0),
        ...fields,
    });
    return { threads: n };
}

async function defaultThreadCount(): Promise<number> {
    try {
        const os = await import(/* @vite-ignore */ NODE_OS);
        return os.availableParallelism?.() ?? os.cpus().length;
    } catch {
        return 4;
    }
}
