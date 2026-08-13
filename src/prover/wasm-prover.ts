// WASM-backed Groth16 prover. Drop-in for `SnarkjsProver`.
// Witness calc via `circom_runtime`; proof via rust ark-groth16 at
// `sdk/wasm/prover/`, with rayon multi-threading on COI pages.
//
// The loader and its configuration hooks live in `./wasm-loader.ts`, which
// carries no `circom_runtime` dependency — see the header there.

import { WitnessCalculatorBuilder } from "circom_runtime";
import { getLogger } from "../log/logger.js";
import { timed, timedSync } from "../log/timed.js";
import { shutdownRayonWorkers } from "../wasm/rayon/index.js";
import { type LoadArtifactOpts, loadArtifactBytes } from "./artifacts.js";
import type { Groth16Proof, ProveResult, Prover, ProverPaths } from "./types.js";
import { loadProver, type ProverSession } from "./wasm-loader.js";

export {
    configureProverThreads,
    configureProverWasm,
    type ProverWasmLoader,
} from "./wasm-loader.js";

interface WitnessCalculator {
    calculateWTNSBin(input: Record<string, unknown>, sanityCheck?: number): Promise<Uint8Array>;
}

const log = getLogger("lelantos:prover:wasm");

const _buildCache = new Map<string, Promise<WasmProver>>();

export class WasmProver implements Prover {
    private constructor(
        private readonly session: ProverSession,
        private readonly wc: WitnessCalculator,
    ) {}

    /**
     * Build (or return the in-flight build for) a prover over `paths`.
     *
     * `opts` reaches the artifact fetch, so a caller can observe or abort the
     * ~49 MB zkey download. It applies only to the call that starts the
     * build: a second caller for the same paths joins the existing promise and
     * sees neither its progress nor its `signal`.
     */
    static async build(paths: ProverPaths, opts: LoadArtifactOpts = {}): Promise<WasmProver> {
        const key = `${paths.zkeyPath}\0${paths.wasmPath}`;
        const cached = _buildCache.get(key);
        if (cached) return cached;
        const p = WasmProver._doBuild(paths, opts).catch((err) => {
            _buildCache.delete(key);
            throw err;
        });
        _buildCache.set(key, p);
        return p;
    }

    private static async _doBuild(paths: ProverPaths, opts: LoadArtifactOpts): Promise<WasmProver> {
        const [Session, zkeyBytes, circuitWasm] = await Promise.all([
            loadProver(),
            loadArtifactBytes(paths.zkeyPath, opts),
            // The witness calculator is ~4 MB against the zkey's ~49; reporting
            // both through one callback would make the bar jump backwards.
            loadArtifactBytes(paths.wasmPath, { ...opts, onProgress: undefined }),
        ]);
        const wc = (await WitnessCalculatorBuilder(circuitWasm)) as WitnessCalculator;
        return new WasmProver(new Session(zkeyBytes), wc);
    }

    /**
     * Warm the wasm module to avoid first-prove latency. With `paths`,
     * also fetches + parses the artifacts (full `build`, cached).
     */
    static async preload(paths?: ProverPaths, opts: LoadArtifactOpts = {}): Promise<void> {
        if (paths) {
            await WasmProver.build(paths, opts);
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
