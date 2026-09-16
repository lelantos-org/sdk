// Prover selection: WASM by default, snarkjs on wasm-load failure, behind a lazy handle.
//
// `LazyProver` defers everything (artifact resolution, the ~29 MB zkey fetch and parse, the
// thread-pool spin-up) until the first proof or an explicit warm-up, so building a wallet does no
// artifact I/O and an app that only reads balances never downloads the prover.

import { type AsyncMemo, memoAsync } from "../../core/async.js";
import { getLogger } from "../../log/logger.js";
import type { CircuitShape } from "../../protocol/shape.js";
import type { ProveResult, Prover, ProverArtifacts } from "../../prover/types.js";
import { detectRuntime, isCrossOriginIsolated } from "../../runtime/detect.js";
import type { ProverConfig, ProverOption } from "../connect/options.js";

const log = getLogger("lelantos:wallet:prover");

/**
 * Build the WASM prover, falling back to snarkjs when the wasm module cannot load (bundler did not
 * resolve `#wasm/prover`, no wasm support). Both backends load dynamically, so a wallet that never
 * proves never pulls in either.
 */
async function wasmProverWithFallback(
    artifacts: ProverArtifacts,
    opts: { force?: boolean | undefined } = {},
): Promise<Prover> {
    const { SnarkjsProver } = await import("../../prover/snarkjs.js");
    // Without cross-origin isolation the wasm prover runs single-threaded, which benchmarks ~2x
    // slower than snarkjs (snarkjs parallelizes internally). Prefer snarkjs there unless wasm was
    // forced explicitly.
    if (!opts.force && detectRuntime() === "browser" && !isCrossOriginIsolated()) {
        // Logged because this downgrade is otherwise silent: a page served without COOP/COEP takes
        // this path on every load.
        log.warn("cross-origin isolation off; proving falls back to snarkjs", {
            fix: "serve with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp",
        });
        return new SnarkjsProver(artifacts);
    }
    try {
        const { WasmProver } = await import("../../prover/wasm-prover.js");
        return await WasmProver.build(artifacts);
    } catch (err) {
        // Via the SDK logger rather than `console`, so apps can route or suppress the only
        // diagnostic for this downgrade.
        log.warn("WASM prover unavailable; falling back to snarkjs", { err });
        return new SnarkjsProver(artifacts);
    }
}

/**
 * Defers a prover build; `prove()` awaits it. A build failure surfaces on the first `prove()` or
 * `warm()`.
 *
 * The build is memoised with eviction, so a transient artifact download failure is retried on the
 * next call rather than disabling the prover for the wallet's lifetime. This matches
 * `loadArtifactBytes` and `WasmProver.build`, which also evict on failure.
 */
class LazyProver implements Prover {
    private readonly built: AsyncMemo<Prover>;

    constructor(start: () => Promise<Prover>) {
        this.built = memoAsync(start);
    }

    /** Build now, and preload a backend that has a separate warm-up step (a worker prover). */
    async warm(): Promise<void> {
        const prover = (await this.built.get()) as Prover & { preload?: () => Promise<void> };
        await prover.preload?.();
    }

    prove(input: Record<string, unknown>): Promise<ProveResult> {
        return this.built.get().then((p) => p.prove(input));
    }

    /**
     * Dispose what was built, if anything was.
     *
     * Uses `inFlight`: unlike `get` it does not start a build for a wallet closed before its first
     * proof, and unlike `peek` it awaits a build in progress so closing during warm-up does not
     * leak the prover.
     */
    async dispose(): Promise<void> {
        const built = await this.built.inFlight()?.catch(() => undefined);
        await built?.dispose?.();
    }
}

/** A prover slot for `prover: "none"`: every proof rejects `PROVER_UNAVAILABLE`. */
function unavailableProver(): Prover {
    return {
        prove: async () => {
            const { ProverUnavailableError } = await import("../../errors/prover.js");
            throw new ProverUnavailableError(
                'no prover configured (`prover: "none"`); spends need one — pass a `Prover` or a ' +
                    "`ProverConfig`",
            );
        },
    };
}

/** What a wallet holds for proving: the prover slot, whether it is real, and how to warm it. */
export interface ProverHandle {
    readonly prover: Prover;
    /** `false` for `prover: "none"`. */
    readonly available: boolean;
    /**
     * Whether the SDK built this prover and so disposes it. `false` for a caller-supplied `Prover`,
     * whose lifetime stays with the caller.
     */
    readonly owned: boolean;
    /** Fetch and warm now. Rejects `PROVER_UNAVAILABLE` when there is no prover. */
    warm(): Promise<void>;
    /** `warmup: "eager"`: warm in the background once the wallet is built. */
    readonly eager: boolean;
}

/** Inputs a prover build reads beyond its option. */
interface ProverBuildContext {
    runtime?: "node" | "browser" | undefined;
    /** Names the artifact pair to resolve. Defaults to `DEFAULT_SHAPE`. */
    shape?: CircuitShape | undefined;
}

/** Whether `option` is a pre-built `Prover`, as opposed to a `ProverConfig`. */
function isProverInstance(option: unknown): option is Prover {
    return (
        typeof option === "object" &&
        option !== null &&
        typeof (option as { prove?: unknown }).prove === "function"
    );
}

/**
 * Turn a {@link ProverOption} into a handle. Does no I/O: a `ProverConfig` becomes a
 * {@link LazyProver} whose build starts at the first proof or `warm()`.
 */
export function buildProverHandle(
    option: ProverOption | undefined,
    ctx: ProverBuildContext = {},
): ProverHandle {
    if (option === "none") {
        return {
            prover: unavailableProver(),
            available: false,
            owned: true,
            eager: false,
            warm: () =>
                unavailableProver()
                    .prove({})
                    .then(() => undefined),
        };
    }
    if (isProverInstance(option)) {
        const prover = option as Prover & { preload?: () => Promise<void> };
        return {
            prover,
            available: true,
            owned: false,
            eager: false,
            warm: async () => {
                await prover.preload?.();
            },
        };
    }
    const config: ProverConfig = option ?? {};
    const lazy = new LazyProver(() => buildFromConfig(config, ctx));
    return {
        prover: lazy,
        available: true,
        owned: true,
        eager: config.warmup === "eager",
        warm: () => lazy.warm(),
    };
}

async function buildFromConfig(config: ProverConfig, ctx: ProverBuildContext): Promise<Prover> {
    // Artifact resolution and fetching load with the build, not with the wallet.
    const { bundledProverArtifacts } = await import("../../prover/artifact-paths.js");
    const artifacts =
        config.artifacts ??
        (await bundledProverArtifacts({
            runtime: ctx.runtime,
            cdn: config.cdn,
            shape: ctx.shape,
        }));
    if (config.worker) {
        const { WorkerProver } = await import("../../prover/worker-client.js");
        return new WorkerProver({
            worker: config.worker(),
            artifacts,
            ...(config.threads !== undefined ? { threads: config.threads } : {}),
        });
    }
    if (config.threads !== undefined) {
        const { configureProverThreads } = await import("../../runtime/wasm/prover-loader.js");
        configureProverThreads(config.threads);
    }
    const backend = config.backend ?? "auto";
    if (backend === "snarkjs") {
        const { SnarkjsProver } = await import("../../prover/snarkjs.js");
        return new SnarkjsProver(artifacts);
    }
    return wasmProverWithFallback(artifacts, { force: backend === "wasm" });
}

/** Problems with a `prover` option, for `WalletConfigError.missing`. Empty when valid. */
export function proverOptionProblems(option: unknown): string[] {
    if (option === undefined || option === "none" || isProverInstance(option)) return [];
    if (typeof option !== "object" || option === null) {
        return ['`prover` (a `Prover`, a `ProverConfig` or "none")'];
    }
    const c = option as Record<string, unknown>;
    const out: string[] = [];
    if (c.backend !== undefined && !["auto", "wasm", "snarkjs"].includes(c.backend as string)) {
        out.push('`prover.backend` ("auto", "wasm" or "snarkjs")');
    }
    if (c.warmup !== undefined && !["lazy", "eager"].includes(c.warmup as string)) {
        out.push('`prover.warmup` ("lazy" or "eager")');
    }
    if (c.worker !== undefined && typeof c.worker !== "function") {
        out.push("`prover.worker` (a WorkerFactory)");
    }
    if (c.threads !== undefined && !(Number.isInteger(c.threads) && (c.threads as number) > 0)) {
        out.push("`prover.threads` (a positive integer)");
    }
    if (c.cdn !== undefined && typeof c.cdn !== "string") out.push("`prover.cdn` (a URL string)");
    if (c.artifacts !== undefined && (typeof c.artifacts !== "object" || c.artifacts === null)) {
        out.push("`prover.artifacts` (`{ circuit, zkey }`)");
    }
    return out;
}
