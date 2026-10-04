// Rayon thread-pool bring-up for `wasm-bindgen-rayon` modules.
//
// Browser and Node both degrade to single-threaded rather than failing, and log
// the cause.

import { withTimeout } from "../../../core/async.js";
import { envProverThreads } from "../../../log/env.js";
import { getLogger } from "../../../log/logger.js";
import { hardwareConcurrency, isCrossOriginIsolated } from "../../detect.js";
import { installNodeRayonWorker, terminateRayonWorkers } from "./node-worker.js";

const NODE_OS = "node:os";

/** Deadline for `initThreadPool` to spawn its workers and settle. */
const INIT_TIMEOUT_MS = 10_000;

const log = getLogger("lelantos:wasm:rayon");

export interface RayonModule {
    initThreadPool?: ((n: number) => Promise<unknown>) | undefined;
}

interface RayonInitOpts {
    /** Caller-supplied override; `null` means "use default". */
    threadCount: number | null;
    /** Tag identifying the module in log records (e.g. "WasmProver"). */
    label: string;
}

/** Why the pool ended up single-threaded, or how many threads it got. */
type RayonOutcome =
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

/**
 * Start `mod`'s rayon thread pool.
 *
 * `nodePkgUrl` is the module's `file://` URL on Node, where rayon's workers are shimmed onto
 * `worker_threads`; `null` in a browser, where the page must be cross-origin isolated
 * (COOP+COEP) for `SharedArrayBuffer`.
 */
export async function initThreadPool(
    mod: RayonModule,
    opts: RayonInitOpts,
    nodePkgUrl: string | null,
): Promise<RayonOutcome> {
    if (!mod.initThreadPool) {
        return singleThreaded(opts.label, "unsupported", "module exposes no initThreadPool");
    }
    if (nodePkgUrl === null && !isCrossOriginIsolated()) {
        return singleThreaded(
            opts.label,
            "not-isolated",
            "crossOriginIsolated=false; set COOP=same-origin and COEP=require-corp on the " +
                "page (and on the worker) to enable rayon",
        );
    }

    const hw = nodePkgUrl === null ? hardwareConcurrency() : undefined;
    const n =
        opts.threadCount ??
        (hw !== undefined ? defaultThreads(hw) : (envProverThreads() ?? (await nodeThreadCount())));
    if (n <= 1) {
        return singleThreaded(opts.label, "requested", `thread count ${n} was requested`);
    }

    if (nodePkgUrl !== null) {
        try {
            await installNodeRayonWorker(nodePkgUrl);
        } catch (err) {
            return singleThreaded(
                opts.label,
                "failed",
                "could not install the Node worker shim",
                err,
            );
        }
    }
    return startPool(mod, n, opts.label, hw !== undefined ? { hardwareConcurrency: hw } : {});
}

/**
 * Threads to run rayon with, given `hardwareConcurrency`: between 2 and 32.
 *
 * Not clamped to 8 like the scanner pool (`sync/worker/pool.ts`): proving
 * still scales past 8 threads.
 *
 * The ceiling is a runaway guard. Each worker is a JS realm plus a stack in
 * the prover's shared wasm memory, which never shrinks, and the MSM
 * parallelises over a bounded number of scalar windows, so workers beyond it
 * cost memory without adding throughput.
 */
function defaultThreads(hw: number): number {
    return Math.max(2, Math.min(32, hw));
}

async function startPool(
    mod: RayonModule,
    n: number,
    label: string,
    fields: Record<string, unknown>,
): Promise<RayonOutcome> {
    const t0 = performance.now();
    try {
        // `withTimeout` clears its timer on success; a pending timer would
        // hold the Node event loop open after init completes.
        await withTimeout(
            mod.initThreadPool!(n),
            INIT_TIMEOUT_MS,
            () => new Error(`initThreadPool timed out after ${INIT_TIMEOUT_MS / 1000}s`),
        );
    } catch (err) {
        // Workers that did boot must not outlive the fallback; see
        // `terminateRayonWorkers`.
        const leaked = await terminateRayonWorkers().catch(() => 0);
        if (leaked > 0) log.debug("terminated workers from a failed pool init", { leaked });
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

async function nodeThreadCount(): Promise<number> {
    try {
        const os = await import(/* @vite-ignore */ NODE_OS);
        // Same clamp as in a browser; see `defaultThreads`.
        return defaultThreads(os.availableParallelism?.() ?? os.cpus().length);
    } catch {
        return 4;
    }
}
