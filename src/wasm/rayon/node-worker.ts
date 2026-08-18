// A browser-`Worker`-shaped adapter over `node:worker_threads`, so
// wasm-bindgen-rayon's `startWorkers` (which does
// `new Worker(url, { type: "module" })`) works under Node.
//
// Each Node worker first runs the static ESM bootstrap in this directory,
// which then dynamic-imports the real workerHelpers URL.
//
// LIFECYCLE
//
// rayon workers park in `Atomics.wait` inside wasm and never return, so each
// one holds a live MessagePort. Left as-is they keep the Node event loop alive
// and the process never exits. Two mechanisms prevent that:
//
//   * every spawned worker is `unref()`d, so an idle pool does not by itself
//     keep the loop alive. Safe because a proof runs as a BLOCKING synchronous
//     wasm call on the main thread — the loop cannot spin down mid-proof — and
//     between proofs the workers are genuinely idle.
//   * `shutdownRayonWorkers()` terminates them for callers who want
//     deterministic teardown (long-lived servers, test suites).

import { getLogger } from "../../log/logger.js";

const NODE_WORKER_THREADS = "node:worker_threads";
const BOOTSTRAP_URL = new URL("./bootstrap.mjs", import.meta.url);

const log = getLogger("lelantos:wasm:rayon");

interface NodeWorkerLike {
    postMessage(msg: unknown): void;
    on(event: string, cb: (arg: never) => void): void;
    terminate(): Promise<number> | undefined;
    unref(): void;
    ref(): void;
}

/**
 * Parent CLI flags that a worker spawned from a file cannot accept.
 *
 * `node:worker_threads` defaults `execArgv` to the parent's, and a parent
 * running in eval mode (`node --input-type=module -e ...`) passes
 * `--input-type`, which kills every worker with ERR_INPUT_TYPE_NOT_ALLOWED and
 * drops the pool to single-threaded.
 *
 * Only flags meaningless for a file entry point are dropped; everything else
 * (`--max-old-space-size`, `--enable-source-maps`, ...) is inherited.
 */
const INCOMPATIBLE_EXEC_ARGV = ["--input-type", "--eval", "-e", "--print", "-p"];

function workerExecArgv(): string[] {
    return process.execArgv.filter(
        (a) => !INCOMPATIBLE_EXEC_ARGV.some((f) => a === f || a.startsWith(`${f}=`)),
    );
}

/** Live workers, so the pool can be torn down on request. */
const spawned = new Set<NodeWorkerLike>();

/**
 * Which pkg URL the installed global `Worker` is bound to.
 *
 * Keyed by URL rather than a bare installed flag: a second wasm module — or
 * the same one re-configured via `configureProverWasm` — would otherwise keep
 * spawning workers pointed at the first module's pkg, surfacing as a 10s init
 * timeout and a drop to single-threaded.
 */
let installedFor: string | null = null;

/** Whatever occupied `globalThis.Worker` before this adapter was installed. */
let previousWorker: unknown;

export async function installNodeRayonWorker(nodePkgUrl: string): Promise<void> {
    if (installedFor === nodePkgUrl) return;

    const { Worker: NodeWorker } = (await import(/* @vite-ignore */ NODE_WORKER_THREADS)) as {
        Worker: new (
            url: URL | string,
            opts: { env: NodeJS.ProcessEnv; execArgv: string[] },
        ) => NodeWorkerLike;
    };

    class NodeBrowserWorker {
        private readonly w: NodeWorkerLike;
        private readonly listeners = new Map<string, Set<(e: { data: unknown }) => void>>();

        constructor(url: URL | string) {
            const target = url instanceof URL ? url.href : String(url);
            this.w = new NodeWorker(BOOTSTRAP_URL, {
                env: {
                    ...process.env,
                    LELANTOS_RAYON_PKG_URL: nodePkgUrl,
                    LELANTOS_RAYON_WORKER_URL: target,
                },
                execArgv: workerExecArgv(),
            });

            spawned.add(this.w);

            this.w.on("message", (data: unknown) => {
                this.emit("message", { data });
            });
            this.w.on("error", (err: Error) => {
                log.warn("rayon worker error", { target, err });
                this.emit("error", { data: err });
            });
            this.w.on("exit", (code: number) => {
                spawned.delete(this.w);
                if (code !== 0) log.debug("rayon worker exited", { target, code });
            });

            // unref after attaching listeners: Node re-refs a MessagePort when
            // a "message" listener is added, so unref'ing first is undone.
            this.w.unref();
        }

        private emit(type: string, ev: { data: unknown }): void {
            const set = this.listeners.get(type);
            if (set) for (const cb of set) cb(ev);
        }

        postMessage(msg: unknown): void {
            this.w.postMessage(msg);
        }

        addEventListener(type: string, cb: (e: { data: unknown }) => void): void {
            let set = this.listeners.get(type);
            if (!set) {
                set = new Set();
                this.listeners.set(type, set);
            }
            set.add(cb);
        }

        removeEventListener(type: string, cb: (e: { data: unknown }) => void): void {
            this.listeners.get(type)?.delete(cb);
        }

        terminate(): void {
            spawned.delete(this.w);
            // `void` marks the value ignored but attaches no rejection
            // handler, so a worker that was already gone surfaced as an
            // unhandled rejection. `shutdownRayonWorkers` catches the same
            // call; this path should too.
            this.w.terminate()?.catch(() => {});
        }
    }

    const g = globalThis as Record<string, unknown>;
    if (installedFor === null) previousWorker = g.Worker;
    g.Worker = NodeBrowserWorker;
    installedFor = nodePkgUrl;
}

/**
 * Terminate every rayon worker and restore the previous `globalThis.Worker`.
 *
 * Not required for a process to exit — the workers are unref'd — but gives
 * long-lived hosts and test suites a deterministic teardown point.
 */
export async function shutdownRayonWorkers(): Promise<void> {
    const terminated = await terminateRayonWorkers();

    if (installedFor !== null) {
        const g = globalThis as Record<string, unknown>;
        if (previousWorker === undefined) delete g.Worker;
        else g.Worker = previousWorker;
        installedFor = null;
        previousWorker = undefined;
    }
    if (terminated > 0) log.debug("rayon pool shut down", { workers: terminated });
}

/**
 * Terminate every spawned worker but leave the `globalThis.Worker` shim in
 * place. Returns how many were terminated.
 *
 * Split out for the failed-init path: `initThreadPool` spawns all N workers
 * before awaiting N readies, so if one fails to boot the promise never settles
 * and the timeout fires — leaving the N-1 that *did* boot parked in
 * `Atomics.wait`, each holding a stack in the prover's shared wasm memory,
 * which can never shrink. Degrading to single-threaded has to take them with
 * it, but must not uninstall the shim a later retry would need.
 */
export async function terminateRayonWorkers(): Promise<number> {
    const workers = [...spawned];
    spawned.clear();
    await Promise.all(
        workers.map(async (w) => {
            try {
                await w.terminate();
            } catch {
                // Already gone; nothing to do.
            }
        }),
    );
    return workers.length;
}

/** Live worker count. Exposed for tests and diagnostics. */
export function rayonWorkerCount(): number {
    return spawned.size;
}
