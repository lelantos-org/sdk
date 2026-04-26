// Rayon thread-pool bring-up for `wasm-bindgen-rayon` modules. Splits browser vs Node paths,
// polyfills the Worker shape Node needs, and degrades to single-threaded on missing prereqs
// (no SharedArrayBuffer, no COI, etc).

const NODE_URL = "node:url";
const NODE_OS = "node:os";
const NODE_WORKER_THREADS = "node:worker_threads";

const RAYON_BOOTSTRAP_URL = new URL("./rayon-worker-bootstrap.mjs", import.meta.url);

export interface RayonModule {
    initThreadPool?: (n: number) => Promise<unknown>;
}

export interface RayonInitOpts {
    /// Caller-supplied override; `null` means "use default".
    threadCount: number | null;
    /// Tag used in the warning log (e.g. "WasmProver").
    label: string;
}

/// `wasm-bindgen-rayon`'s workerHelpers.js references `self.addEventListener` at module top
/// level. Stub the Worker-shaped globals so module load succeeds in Node.
export function polyfillSelfForNode(): void {
    const g = globalThis as Record<string, unknown>;
    if (g.self === undefined) g.self = globalThis;
    for (const k of ["addEventListener", "removeEventListener", "postMessage"]) {
        if (g[k] === undefined) g[k] = () => {};
    }
}

export async function initBrowserThreadPool(mod: RayonModule, opts: RayonInitOpts): Promise<void> {
    if (!mod.initThreadPool) {
        // eslint-disable-next-line no-console
        console.warn(`[${opts.label}] mod.initThreadPool missing — running single-threaded`);
        return;
    }
    // Requires `crossOriginIsolated` (COOP+COEP headers). Without it `SharedArrayBuffer` is
    // unavailable and rayon falls back to the current thread — slow but correct.
    const coi = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    if (!coi) {
        // eslint-disable-next-line no-console
        console.warn(
            `[${opts.label}] crossOriginIsolated=false — running single-threaded. ` +
                "Set COOP=same-origin + COEP=require-corp on the page (and worker) to enable rayon.",
        );
        return;
    }
    const hw =
        (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
            ?.hardwareConcurrency ?? 4;
    const n = opts.threadCount ?? Math.max(2, hw);
    if (n <= 1) {
        // eslint-disable-next-line no-console
        console.warn(`[${opts.label}] thread pool size ${n} — running single-threaded`);
        return;
    }
    const t0 = performance.now();
    try {
        await raceWithTimeout(mod.initThreadPool(n), 10_000);
        // eslint-disable-next-line no-console
        console.log(
            `[${opts.label}] rayon thread pool ready: ${n} threads (${(performance.now() - t0).toFixed(0)}ms, hw=${hw})`,
        );
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
            `[${opts.label}] rayon thread pool init failed; running single-threaded:`,
            err,
        );
    }
}

export async function initNodeThreadPool(
    mod: RayonModule,
    nodePkgUrl: string,
    opts: RayonInitOpts,
): Promise<void> {
    if (!mod.initThreadPool) return;
    const envN = parseInt(process.env.LELANTOS_PROVER_THREADS ?? "", 10);
    const n = opts.threadCount ?? (Number.isFinite(envN) ? envN : await defaultThreadCount());
    if (n <= 1) return;
    try {
        await installNodeRayonWorker(nodePkgUrl);
        await raceWithTimeout(mod.initThreadPool(n), 10_000);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
            `[${opts.label}] rayon thread pool init failed; running single-threaded:`,
            err,
        );
    }
}

async function defaultThreadCount(): Promise<number> {
    try {
        const os = await import(/* @vite-ignore */ NODE_OS);
        return os.availableParallelism?.() ?? os.cpus().length;
    } catch {
        return 4;
    }
}

function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    const timeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`initThreadPool timeout (${ms / 1000}s)`)), ms),
    );
    return Promise.race([p, timeout]);
}

let nodeRayonInstalled = false;

/// Adapt browser-Worker API to `node:worker_threads` so wasm-bindgen-rayon's `startWorkers`
/// (which does `new Worker(url, {type:"module"})`) functions in Node. Each Node worker first
/// runs a static ESM bootstrap, then dynamic-imports the real workerHelpers.js URL.
async function installNodeRayonWorker(nodePkgUrl: string): Promise<void> {
    if (nodeRayonInstalled) return;
    const { Worker: NodeWorker } = await import(/* @vite-ignore */ NODE_WORKER_THREADS);
    const bootstrap = RAYON_BOOTSTRAP_URL;

    class NodeBrowserWorker {
        private readonly w: InstanceType<typeof NodeWorker>;
        private readonly listeners = new Map<string, Set<(e: { data: unknown }) => void>>();
        constructor(url: URL | string) {
            const target = url instanceof URL ? url.href : String(url);
            this.w = new NodeWorker(bootstrap, {
                env: {
                    ...process.env,
                    LELANTOS_RAYON_PKG_URL: nodePkgUrl,
                    LELANTOS_RAYON_WORKER_URL: target,
                },
            });
            const dbg = (m: string) => {
                if (process.env.LELANTOS_RAYON_DEBUG) console.error(`[rayon-main ${target}]`, m);
            };
            dbg("worker spawned");
            this.w.on("message", (data: unknown) => {
                dbg(`message ${(data as { type?: string })?.type}`);
                const set = this.listeners.get("message");
                if (set) for (const cb of set) cb({ data });
            });
            this.w.on("error", (err: Error) => {
                dbg(`error ${err.message}`);
                const set = this.listeners.get("error");
                if (set) for (const cb of set) cb({ data: err });
            });
            this.w.on("exit", (code: number) => dbg(`exit ${code}`));
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
            void this.w.terminate();
        }
    }

    const g = globalThis as Record<string, unknown>;
    if (g.Worker === undefined) g.Worker = NodeBrowserWorker;
    nodeRayonInstalled = true;
}

export async function nodeFileUrlToPath(url: URL): Promise<string> {
    const { fileURLToPath } = await import(/* @vite-ignore */ NODE_URL);
    return fileURLToPath(url);
}
