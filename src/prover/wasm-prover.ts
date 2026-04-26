// WASM-backed Groth16 prover. Drop-in for `SnarkjsProver`.
// Witness calc via `circom_runtime`; proof via rust ark-groth16 at
// `sdk/wasm/prover/`, with rayon multi-threading on COI pages.

import { WitnessCalculatorBuilder } from "circom_runtime";
import { getLogger } from "../log/logger.js";
import { timed, timedSync } from "../log/timed.js";
import { createWasmLoader, type WasmLoaderOverride, type WasmModuleBase } from "../wasm/loader.js";
import { nodeFileUrlToPath } from "../wasm/node-path.js";
import {
    initBrowserThreadPool,
    initNodeThreadPool,
    shutdownRayonWorkers,
    withWorkerGlobals,
} from "../wasm/rayon/index.js";
import { loadArtifactBytes } from "./artifacts.js";
import type { Groth16Proof, ProveResult, Prover, ProverPaths } from "./types.js";

const IS_NODE = typeof process !== "undefined" && !!process.versions?.node;

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

/**
 * Browser bundlers rewrite the relative-path fallback to a runtime-missing
 * path. Inject a loader that resolves the wasm-pack module + binary via the
 * bundler's asset-URL pipeline before `WasmProver.build()`.
 */
const log = getLogger("lelantos:prover:wasm");

export type ProverWasmLoader = WasmLoaderOverride<ProverModule>;

/**
 * Override rayon thread count. Pass 0 or 1 for single-threaded. Must be set
 * before the first `WasmProver.build` / `preload`; later changes are ignored.
 */
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

async function loadProver(): Promise<ProverCtor> {
    // The worker-shaped globals are only needed while the pkg module
    // evaluates; `withWorkerGlobals` removes them afterwards so the host's
    // main thread stops looking like a Web Worker to every other library.
    const mod = IS_NODE
        ? await withWorkerGlobals(() => proverLoader.load())
        : await proverLoader.load();
    return mod.ProverSession;
}

const _buildCache = new Map<string, Promise<WasmProver>>();

export class WasmProver implements Prover {
    private constructor(
        private readonly session: ProverSession,
        private readonly wc: WitnessCalculator,
    ) {}

    static async build(paths: ProverPaths): Promise<WasmProver> {
        const key = `${paths.zkeyPath}\0${paths.wasmPath}`;
        const cached = _buildCache.get(key);
        if (cached) return cached;
        const p = WasmProver._doBuild(paths).catch((err) => {
            _buildCache.delete(key);
            throw err;
        });
        _buildCache.set(key, p);
        return p;
    }

    private static async _doBuild(paths: ProverPaths): Promise<WasmProver> {
        const [Session, zkeyBytes, circuitWasm] = await Promise.all([
            loadProver(),
            loadArtifactBytes(paths.zkeyPath),
            loadArtifactBytes(paths.wasmPath),
        ]);
        const wc = (await WitnessCalculatorBuilder(circuitWasm)) as WitnessCalculator;
        return new WasmProver(new Session(zkeyBytes), wc);
    }

    /**
     * Warm the wasm module to avoid first-prove latency. With `paths`,
     * also fetches + parses the artifacts (full `build`, cached).
     */
    static async preload(paths?: ProverPaths): Promise<void> {
        if (paths) {
            await WasmProver.build(paths);
            return;
        }
        await loadProver();
    }

    /**
     * Terminate the rayon worker pool.
     *
     * Not needed for a process to exit — the workers are unref'd — but
     * gives long-lived hosts and test suites a deterministic teardown
     * point. Safe to call when no pool was ever started.
     */
    static async shutdown(): Promise<void> {
        await shutdownRayonWorkers();
    }

    async prove(input: Record<string, unknown>): Promise<ProveResult> {
        const wtns = await timed(log, "witness", () => this.wc.calculateWTNSBin(input, 0));
        const out = timedSync(log, "groth16", () => this.session.prove(wtns));
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
