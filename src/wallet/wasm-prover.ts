// WASM-backed Groth16 prover. Drop-in for `SnarkjsProver` — same `Prover`
// interface, same `ProveResult` shape (snarkjs decimal strings).
//
// Witness calc reuses `circom_runtime` (transitive via snarkjs ≥ 0.7) so apps
// need no new package. Proof runs in the rust ark-groth16 crate at
// `sdk/wasm/prover/`, with rayon multi-threading on COI pages.

import { WitnessCalculatorBuilder } from "circom_runtime";

import type { Prover } from "./prover";
import type { ProveResult, Groth16Proof, ProverPaths } from "../prover";

const IS_NODE = typeof process !== "undefined" && !!process.versions?.node;

// ── runtime types ──────────────────────────────────────────────────────────
interface ProverSession {
    prove(wtnsBytes: Uint8Array): RawProofOutput;
}
type ProverCtor = new (zkeyBytes: Uint8Array) => ProverSession;

interface ProverModule {
    default: (input?: {
        module_or_path?: string | URL | ArrayBuffer | Uint8Array;
    }) => Promise<unknown>;
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

// ── lazy singleton: load wasm-pack module + init the wasm binary ───────────
let proverPromise: Promise<ProverCtor> | null = null;
function loadProver(): Promise<ProverCtor> {
    if (!proverPromise) proverPromise = initProver();
    return proverPromise;
}

// Indirect eval: bypasses TS CJS lowering so `import()` stays a real ESM
// import. wasm-pack `--target web` output is ESM and require() rejects it.
const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;

/// Browser apps that bundle the SDK can't rely on the relative-path fallback
/// (`../../wasm/prover/pkg/prover.js`) — the bundler rewrites it to a path
/// that doesn't exist at runtime. Inject a loader that resolves the wasm-pack
/// module + binary using the bundler's own asset-URL pipeline before
/// `WasmProver.build()`.
export interface ProverWasmLoader {
    loadModule(): Promise<ProverModule>;
    wasm?: string | URL | ArrayBuffer | Uint8Array;
}

let injectedLoader: ProverWasmLoader | null = null;

export function configureProverWasm(loader: ProverWasmLoader): void {
    injectedLoader = loader;
    proverPromise = null;
}

/// Override the rayon thread count. Default in Node = `availableParallelism()`.
/// Pass 0 (or 1) to keep the prover single-threaded. Must be called before
/// the first `WasmProver.build` / `WasmProver.preload` to take effect; later
/// changes are ignored because the wasm pool is initialized once.
let proverThreadCount: number | null = null;
export function configureProverThreads(n: number): void {
    proverThreadCount = n;
}

async function initProver(): Promise<ProverCtor> {
    if (IS_NODE) polyfillSelfForNode();
    let mod: ProverModule;
    if (injectedLoader) {
        mod = await injectedLoader.loadModule();
        await mod.default(
            injectedLoader.wasm !== undefined
                ? { module_or_path: injectedLoader.wasm }
                : undefined,
        );
    } else if (IS_NODE) {
        const { join } = await import("node:path");
        const { pathToFileURL } = await import("node:url");
        const pkgDir = join(__dirname, "..", "..", "wasm", "prover", "pkg");
        const pkgUrl = pathToFileURL(join(pkgDir, "prover.js")).href;
        nodePkgUrl = pkgUrl;
        mod = (await esmImport(pkgUrl)) as ProverModule;
        await mod.default({ module_or_path: await readProverWasm() });
    } else {
        mod = (await esmImport("../../wasm/prover/pkg/prover.js")) as ProverModule;
        await mod.default();
    }
    if (IS_NODE) await maybeInitNodeThreadPool(mod);
    return mod.ProverSession;
}

async function maybeInitNodeThreadPool(mod: ProverModule): Promise<void> {
    if (!mod.initThreadPool) return;
    // On by default: rayon thread count = `availableParallelism()`.
    // Override via `configureProverThreads(n)` or `LELANTOS_PROVER_THREADS=n`.
    // Set to 1 to disable.
    const envN = parseInt(process.env.LELANTOS_PROVER_THREADS ?? "", 10);
    const n = proverThreadCount ?? (Number.isFinite(envN) ? envN : defaultThreadCount());
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
// Node. Each spawned Node worker first runs a small ESM bootstrap that
// shims `self`/`addEventListener`/`postMessage`, then dynamic-imports the
// real workerHelpers.js URL. Memory is `WebAssembly.Memory({shared:true})`,
// which Node supports.
let nodeRayonInstalled = false;
let bootstrapPath: string | null = null;
let nodePkgUrl: string | null = null;

function defaultThreadCount(): number {
    try {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic require
        const os = require("node:os") as {
            availableParallelism?: () => number;
            cpus: () => unknown[];
        };
        return os.availableParallelism?.() ?? os.cpus().length;
    } catch {
        return 4;
    }
}

async function ensureBootstrapFile(): Promise<string> {
    if (bootstrapPath) return bootstrapPath;
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = join(tmpdir(), "lelantos-wasm-rayon");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "rayon-worker-bootstrap.mjs");
    // Implements wasm-bindgen-rayon worker protocol directly. Spec:
    //   main → worker: { type:'wasm_bindgen_worker_init', init, receiver }
    //   worker → main: { type:'wasm_bindgen_worker_ready' }
    //   worker then calls pkg.wbg_rayon_start_worker(receiver) which
    //   blocks the rayon dispatcher (Atomics.wait inside wasm).
    const src = `import { parentPort, threadId } from "node:worker_threads";
const dbg = (m) => { if (process.env.LELANTOS_RAYON_DEBUG) console.error("[rayon-worker " + threadId + "]", m); };
// Stub browser-Worker globals so workerHelpers.js (loaded transitively by
// pkg/prover.js) doesn't ReferenceError. We don't route messages through
// these — bootstrap talks to parentPort directly per the rayon protocol.
globalThis.self = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.postMessage = () => {};
const pkgUrl = process.env.LELANTOS_RAYON_PKG_URL;
if (!pkgUrl) throw new Error("LELANTOS_RAYON_PKG_URL missing");
dbg("waiting init");
parentPort.once("message", async (data) => {
    try {
        dbg("got " + (data && data.type));
        if (data?.type !== "wasm_bindgen_worker_init") return;
        const pkg = await import(pkgUrl);
        await pkg.default(data.init);
        dbg("wasm initialized; posting ready");
        parentPort.postMessage({ type: "wasm_bindgen_worker_ready" });
        pkg.wbg_rayon_start_worker(data.receiver);
        dbg("start_worker returned");
    } catch (err) {
        dbg("worker error: " + (err && err.stack || err));
        throw err;
    }
});
`;
    await writeFile(file, src);
    bootstrapPath = file;
    return file;
}

async function installNodeRayonWorker(): Promise<void> {
    if (nodeRayonInstalled) return;
    if (!nodePkgUrl) throw new Error("nodePkgUrl not set; call after wasm init");
    const { Worker: NodeWorker } = await import("node:worker_threads");
    const bootstrap = await ensureBootstrapFile();
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


async function readProverWasm(): Promise<Uint8Array> {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    return new Uint8Array(
        await readFile(join(__dirname, "..", "..", "wasm", "prover", "pkg", "prover_bg.wasm")),
    );
}

async function loadBytes(path: string): Promise<Uint8Array> {
    if (IS_NODE) {
        const { readFile } = await import("node:fs/promises");
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
        const wtns = await this.wc.calculateWTNSBin(input, 0);
        const out = this.session.prove(wtns);
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
