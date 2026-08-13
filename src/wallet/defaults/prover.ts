// Prover selection: WASM by default, snarkjs on wasm-load failure.
//
// `LazyProver` defers the build until the first proof — ~49 MB of artifacts at
// `DEFAULT_SHAPE`, minus whatever `configureArtifactCache` already persisted —
// so `connect()` stays fast for apps that only read balances.

import type { CircuitShape } from "../../core/shape.js";
import {
    bundledProverArtifacts,
    type ProverArtifacts,
    resolveArtifacts,
} from "../../prover/artifacts.js";
import { SnarkjsProver } from "../../prover/snarkjs.js";
import type { ProveResult, Prover, ProverPaths } from "../../prover/types.js";
import type { WalletConfig } from "../config.js";

async function wasmProverWithFallback(
    paths: ProverPaths,
    opts: { force?: boolean | undefined } = {},
): Promise<Prover> {
    // Without cross-origin isolation the wasm prover runs single-threaded,
    // which benches ~2x slower than snarkjs (snarkjs parallelizes
    // internally). Prefer snarkjs there unless wasm was forced explicitly.
    const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
    if (!opts.force && isBrowser && globalThis.crossOriginIsolated !== true) {
        return new SnarkjsProver(paths);
    }
    try {
        const { WasmProver } = await import("../../prover/wasm-prover.js");
        return await WasmProver.build(paths);
    } catch (err) {
        console.warn("[lelantos-sdk] WASM prover unavailable; falling back to snarkjs:", err);
        return new SnarkjsProver(paths);
    }
}

/**
 * Default prover. Uses `cfg.proverPaths` if set, else resolves via
 * `bundledProverArtifacts()`; prefers the WASM prover (zkey parsed once,
 * session cached) with snarkjs as fallback. Throws
 * `ProverArtifactsMissingError` when nothing resolves.
 */
export async function defaultProver(cfg: WalletConfig): Promise<Prover> {
    const paths =
        cfg.proverPaths ??
        (resolveArtifacts(await bundledProverArtifacts({ shape: cfg.shape })) as ProverPaths);
    return wasmProverWithFallback(paths);
}

/** Inputs `connect()` collects to wire the default `ViemChainAdapter`. */

export interface ProverBuildInputs {
    prover?: Prover | undefined;
    proverArtifacts?: ProverArtifacts | ProverPaths | undefined;
    proverArtifactsCdn?: string | undefined;
    useWasmProver?: boolean | undefined;
    proverWarmup?: "eager" | "lazy" | undefined;
    /** Names the artifact pair to resolve. Defaults to `DEFAULT_SHAPE`. */
    shape?: CircuitShape | undefined;
}

/**
 * Defers the prover build off `connect()`'s critical path; `prove()`
 * awaits it. A build failure surfaces on the first `prove()` call.
 */
class LazyProver implements Prover {
    private built?: Promise<Prover>;
    constructor(private readonly start: () => Promise<Prover>) {}

    /** Kick the build in the background without blocking the caller. */
    warm(): void {
        this.ensure().catch(() => {
            // Swallowed here to avoid an unhandled rejection; the retained
            // promise re-throws on the first `prove()`.
        });
    }

    private ensure(): Promise<Prover> {
        this.built ??= this.start();
        return this.built;
    }

    prove(input: Record<string, unknown>): Promise<ProveResult> {
        return this.ensure().then((p) => p.prove(input));
    }
}

/**
 * Build the optional `Prover` for `connect()`. Returning `undefined`
 * defers to `Wallet.create` → `defaultProver`.
 */
export async function buildConnectProver(
    inputs: ProverBuildInputs,
    runtime: "node" | "browser",
): Promise<Prover | undefined> {
    if (inputs.prover) return inputs.prover;

    // Defer to `Wallet.create` → `defaultProver` on explicit snarkjs
    // opt-out without artifacts; keeps fallback resolution in one place.
    const useWasm = inputs.useWasmProver ?? true;
    if (!useWasm && !inputs.proverArtifacts) return undefined;

    // Artifact resolution stays eager so misconfiguration throws at
    // `connect()`; only the zkey fetch/parse + thread-pool spin-up defer.
    const artifacts = inputs.proverArtifacts
        ? inputs.proverArtifacts
        : await bundledProverArtifacts({
              runtime,
              cdn: inputs.proverArtifactsCdn,
              shape: inputs.shape,
          });
    const paths = resolveArtifacts(artifacts);
    if (!useWasm) return new SnarkjsProver(paths);
    const force = inputs.useWasmProver === true;
    const lazy = new LazyProver(() => wasmProverWithFallback(paths, { force }));
    if (inputs.proverWarmup !== "lazy") lazy.warm();
    return lazy;
}

/**
 * Fill in every omitted pluggable, producing the config the `Wallet` runs on.
 * Single source of the defaulting rules.
 */
