// WASM-backed Groth16 prover. Drop-in for `SnarkjsProver`.
// Witness calc via `circom_runtime`; proof via rust ark-groth16 at
// `sdk/wasm/prover/`, with rayon multi-threading on COI pages.

import { WitnessCalculatorBuilder } from "circom_runtime";
import { createWasmLoader, type WasmLoaderOverride, type WasmModuleBase } from "../wasm/loader.js";
import {
    initBrowserThreadPool,
    initNodeThreadPool,
    nodeFileUrlToPath,
    polyfillSelfForNode,
} from "../wasm/rayon-setup.js";
import type { Prover } from "./interface.js";
import type { Groth16Proof, ProveResult, ProverPaths } from "./snarkjs.js";

const IS_NODE = typeof process !== "undefined" && !!process.versions?.node;
const NODE_FS_PROMISES = "node:fs/promises";

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

/// Browser bundlers rewrite the relative-path fallback to a runtime-missing
/// path. Inject a loader that resolves the wasm-pack module + binary via the
/// bundler's asset-URL pipeline before `WasmProver.build()`.
export type ProverWasmLoader = WasmLoaderOverride<ProverModule>;

/// Override rayon thread count. Pass 0 or 1 for single-threaded. Must be set
/// before the first `WasmProver.build` / `preload`; later changes are ignored.
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
    nodeWasmPath: async () => nodeFileUrlToPath(PKG_WASM_URL),
    postInit: async (mod, ctx) => {
        const opts = { threadCount: proverThreadCount, label: "WasmProver" };
        if (ctx.isNode) {
            if (!ctx.nodePkgUrl) throw new Error("nodePkgUrl not set; call after wasm init");
            await initNodeThreadPool(mod, ctx.nodePkgUrl, opts);
        } else {
            await initBrowserThreadPool(mod, opts);
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

async function loadBytes(path: string): Promise<Uint8Array> {
    if (IS_NODE) {
        const { readFile } = await import(/* @vite-ignore */ NODE_FS_PROMISES);
        return new Uint8Array(await readFile(path));
    }
    const res = await fetch(path);
    if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
}

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

    /// Warm the wasm module (zkey-independent) to avoid first-prove latency.
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
