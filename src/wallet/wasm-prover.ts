// WASM-backed Groth16 prover. Drop-in for `SnarkjsProver` — same `Prover`
// interface, same `ProveResult` shape (snarkjs decimal strings).
//
// Witness calc reuses `circom_runtime` (transitive via snarkjs ≥ 0.7) so apps
// need no new package. Proof runs in the rust ark-groth16 crate at
// `sdk/wasm/prover/`, with rayon multi-threading on COI pages.

import { WitnessCalculatorBuilder } from "circom_runtime";
import type { Groth16Proof, ProveResult, ProverPaths } from "../prover.js";
import { createWasmLoader, type WasmLoaderOverride, type WasmModuleBase } from "../wasm/loader.js";
import type { Prover } from "./prover.js";

const IS_NODE = typeof process !== "undefined" && !!process.versions?.node;

// `node:*` specifiers held in variables so Vite stops trying to resolve
// them statically in browser builds. Reached only on Node.
const NODE_URL = "node:url";
const NODE_OS = "node:os";
const NODE_WORKER_THREADS = "node:worker_threads";
const NODE_FS_PROMISES = "node:fs/promises";

// `pkg/` URLs resolved via the SDK's package `imports` map and own ESM URL.
// Bundlers honour the same map, so consumers do not need to wire paths.

// ── runtime types ──────────────────────────────────────────────────────────
interface ProverSession {
    prove(wtnsBytes: Uint8Array): RawProofOutput;
}
type ProverCtor = new (zkeyBytes: Uint8Array) => ProverSession;

interface ProverModule extends WasmModuleBase {
    ProverSession: ProverCtor;
    initThreadPool?: (n: number) => Promise<unknown>;
}

interface WitnessCalculator {
    calculateWTNSBin(input: Record<string, unknown>, sanityCheck?: number): Promise<Uint8Array>;
}

interface RawProofOutput {
    piA: [string, string, string];
    piB: [[string, string], [string, string], [string, string]];
    piC: [string, string, string];
    publicSignals: string[];
}

/// Browser apps that bundle the SDK can't rely on the relative-path fallback
/// (`../../wasm/prover/pkg/prover.js`) — the bundler rewrites it to a path
/// that doesn't exist at runtime. Inject a loader that resolves the wasm-pack
/// module + binary using the bundler's own asset-URL pipeline before
/// `WasmProver.build()`.
export type ProverWasmLoader = WasmLoaderOverride<ProverModule>;

/// Override the rayon thread count. Default in Node = `availableParallelism()`.
/// Pass 0 (or 1) to keep the prover single-threaded. Must be called before
/// the first `WasmProver.build` / `WasmProver.preload` to take effect; later
/// changes are ignored because the wasm pool is initialized once.
let proverThreadCount: number | null = null;
export function configureProverThreads(n: number): void {
    proverThreadCount = n;
}

const PKG_JS_URL = new URL("../../wasm/prover/pkg/prover.js", import.meta.url);
const PKG_WASM_URL = new URL("../../wasm/prover/pkg/prover_bg.wasm", import.meta.url);

const proverLoader = createWasmLoader<ProverModule>({
    name: "prover",
    defaultImport: () => import("#wasm/prover") as Promise<ProverModule>,
    nodeJsUrl: async () => PKG_JS_URL.href,
    nodeWasmPath: async () => {
        const { fileURLToPath } = await import(/* @vite-ignore */ NODE_URL);
        return fileURLToPath(PKG_WASM_URL);
    },
    postInit: async (mod, ctx) => {
        if (ctx.isNode) {
            nodePkgUrl = ctx.nodePkgUrl;
            await maybeInitNodeThreadPool(mod);
        } else {
            await maybeInitBrowserThreadPool(mod);
        }
    },
});

export function configureProverWasm(loader: ProverWasmLoader): void {
    proverLoader.configure(loader);
}

function loadProver(): Promise<ProverCtor> {
    if (IS_NODE) polyfillSelfForNode();
    return proverLoader.load().then((m) => m.ProverSession);
}

async function maybeInitBrowserThreadPool(mod: ProverModule): Promise<void> {
    if (!mod.initThreadPool) {
        // eslint-disable-next-line no-console
        console.warn("[WasmProver] mod.initThreadPool missing — running single-threaded");
        return;
    }
    // Requires `crossOriginIsolated` (COOP+COEP headers). Without it
    // `SharedArrayBuffer` is unavailable and rayon falls back to the
    // current thread — slow but correct, so we just warn.
    const coi = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    if (!coi) {
        // eslint-disable-next-line no-console
        console.warn(
            "[WasmProver] crossOriginIsolated=false — running single-threaded. " +
                "Set COOP=same-origin + COEP=require-corp on the page (and worker) to enable rayon.",
        );
        return;
    }
    const hw =
        (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
            ?.hardwareConcurrency ?? 4;
    // Empirically rayon scales linearly past 8 cores on transact_2x2
    // (16 threads → ~32% faster than 8 on a 16-core machine), so default
    // to all reported logical cores. `configureProverThreads(n)` overrides.
    const n = proverThreadCount ?? Math.max(2, hw);
    if (n <= 1) {
        // eslint-disable-next-line no-console
        console.warn(`[WasmProver] thread pool size ${n} — running single-threaded`);
        return;
    }
    const t0 = performance.now();
    try {
        const initPromise = mod.initThreadPool(n);
        const timeout = new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("initThreadPool timeout (10s)")), 10_000),
        );
        await Promise.race([initPromise, timeout]);
        // eslint-disable-next-line no-console
        console.log(
            `[WasmProver] rayon thread pool ready: ${n} threads (${(performance.now() - t0).toFixed(0)}ms, hw=${hw})`,
        );
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[WasmProver] rayon thread pool init failed; running single-threaded:", err);
    }
}

async function maybeInitNodeThreadPool(mod: ProverModule): Promise<void> {
    if (!mod.initThreadPool) return;
    // On by default: rayon thread count = `availableParallelism()`.
    // Override via `configureProverThreads(n)` or `LELANTOS_PROVER_THREADS=n`.
    // Set to 1 to disable.
    const envN = parseInt(process.env.LELANTOS_PROVER_THREADS ?? "", 10);
    const n = proverThreadCount ?? (Number.isFinite(envN) ? envN : await defaultThreadCount());
    if (n <= 1) return;
    try {
        await installNodeRayonWorker();
        const initPromise = mod.initThreadPool(n);
        const timeout = new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("initThreadPool timeout (10s)")), 10_000),
        );
        await Promise.race([initPromise, timeout]);
    } catch (err) {
        // Falling back to single-threaded execution is always correct; warn
        // so users notice that the multi-threaded path silently degraded.
        // eslint-disable-next-line no-console
        console.warn("[WasmProver] rayon thread pool init failed; running single-threaded:", err);
    }
}

// `wasm-pack --target web` pulls in `wasm-bindgen-rayon`'s workerHelpers.js,
// which references `self.addEventListener` at module top level. Stub the
// Worker-shaped globals so module load succeeds in Node. No-op listeners
// only fire on the main thread; per-worker handlers run inside the Node
// worker_threads bootstrap (see `installNodeRayonWorker`).
function polyfillSelfForNode(): void {
    const g = globalThis as Record<string, unknown>;
    if (g.self === undefined) g.self = globalThis;
    for (const k of ["addEventListener", "removeEventListener", "postMessage"]) {
        if (g[k] === undefined) g[k] = () => {};
    }
}

// Adapt browser-Worker API to `node:worker_threads` so wasm-bindgen-rayon's
// `startWorkers` (which does `new Worker(url, {type:"module"})`) functions in
// Node. Each spawned Node worker first runs a static ESM bootstrap shipped
// alongside the SDK (`rayon-worker-bootstrap.mjs`) that shims `self`/
// `addEventListener`/`postMessage`, then dynamic-imports the real
// workerHelpers.js URL. Memory is `WebAssembly.Memory({shared:true})`,
// which Node supports.
const RAYON_BOOTSTRAP_URL = new URL("../wasm/rayon-worker-bootstrap.mjs", import.meta.url);
let nodeRayonInstalled = false;
let nodePkgUrl: string | null = null;

async function defaultThreadCount(): Promise<number> {
    try {
        const os = await import(/* @vite-ignore */ NODE_OS);
        return os.availableParallelism?.() ?? os.cpus().length;
    } catch {
        return 4;
    }
}

async function installNodeRayonWorker(): Promise<void> {
    if (nodeRayonInstalled) return;
    if (!nodePkgUrl) throw new Error("nodePkgUrl not set; call after wasm init");
    const { Worker: NodeWorker } = await import(/* @vite-ignore */ NODE_WORKER_THREADS);
    const bootstrap = RAYON_BOOTSTRAP_URL;
    const pkgUrl = nodePkgUrl;

    class NodeBrowserWorker {
        private readonly w: InstanceType<typeof NodeWorker>;
        private readonly listeners = new Map<string, Set<(e: { data: unknown }) => void>>();
        constructor(url: URL | string) {
            const target = url instanceof URL ? url.href : String(url);
            this.w = new NodeWorker(bootstrap, {
                env: {
                    ...process.env,
                    LELANTOS_RAYON_PKG_URL: pkgUrl,
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

async function loadBytes(path: string): Promise<Uint8Array> {
    if (IS_NODE) {
        const { readFile } = await import(/* @vite-ignore */ NODE_FS_PROMISES);
        return new Uint8Array(await readFile(path));
    }
    const res = await fetch(path);
    if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
}

// ── public ─────────────────────────────────────────────────────────────────
export class WasmProver implements Prover {
    private constructor(
        private readonly session: ProverSession,
        private readonly wc: WitnessCalculator,
    ) {}

    static async build(paths: ProverPaths): Promise<WasmProver> {
        const [Session, zkeyBytes, circuitWasm] = await Promise.all([
            loadProver(),
            loadBytes(paths.zkeyPath),
            loadBytes(paths.wasmPath),
        ]);
        const wc = (await WitnessCalculatorBuilder(circuitWasm)) as WitnessCalculator;
        return new WasmProver(new Session(zkeyBytes), wc);
    }

    /// Warm the wasm module (zkey-independent). Use from `preloadWasm()` to
    /// avoid first-prove latency at the worst moment.
    static async preload(): Promise<void> {
        await loadProver();
    }

    async prove(input: Record<string, unknown>): Promise<ProveResult> {
        const perf =
            (globalThis as { __lelantos_prover_perf?: boolean }).__lelantos_prover_perf !== false;
        const t0 = perf ? performance.now() : 0;
        const wtns = await this.wc.calculateWTNSBin(input, 0);
        const t1 = perf ? performance.now() : 0;
        const out = this.session.prove(wtns);
        const t2 = perf ? performance.now() : 0;
        if (perf) {
            const fmt = (ms: number) =>
                ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`;
            // eslint-disable-next-line no-console
            console.log(`[worker-perf] witness: ${fmt(t1 - t0)} | groth16: ${fmt(t2 - t1)}`);
        }
        const proof: Groth16Proof = {
            pi_a: out.piA,
            pi_b: out.piB,
            pi_c: out.piC,
            protocol: "groth16",
            curve: "bn128",
        };
        return { proof, publicSignals: out.publicSignals };
    }
}
