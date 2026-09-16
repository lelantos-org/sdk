// WASM-backed Groth16 prover. Drop-in for `SnarkjsProver`.
// Witness calc via `circom_runtime`; proof via rust ark-groth16 at
// `sdk/wasm/prover/`, with rayon multi-threading on COI pages.
//
// `circom_runtime` (a transitive dependency of the optional `snarkjs` peer) is imported lazily on
// the first build, so the `./prover` entry, which exports this class, resolves without it. The
// loader and its configuration hooks live in `runtime/wasm/prover-loader.ts`.

import type * as CircomRuntimeT from "circom_runtime";
import { memoAsync, memoAsyncByKey } from "../core/async.js";
import { ProverUnavailableError } from "../errors/prover.js";
import { getLogger } from "../log/logger.js";
import { timed, timedSync } from "../log/timed.js";
import {
    loadProver,
    type ProverSession,
    resetProverModule,
} from "../runtime/wasm/prover-loader.js";
import { rayonWorkerCount, shutdownRayonWorkers } from "../runtime/wasm/rayon/index.js";
import {
    type LoadArtifactOpts,
    loadArtifactBytes,
    releaseArtifactBytes,
} from "./artifact-bytes.js";
import { resolveArtifacts } from "./artifact-paths.js";
import type { Groth16Proof, ProveResult, Prover, ProverArtifacts, ProverPaths } from "./types.js";

export {
    configureProverThreads,
    configureProverWasm,
    type ProverWasmLoader,
} from "../runtime/wasm/prover-loader.js";

interface WitnessCalculator {
    calculateWTNSBin(input: Record<string, unknown>, sanityCheck?: number): Promise<Uint8Array>;
}

const log = getLogger("lelantos:prover:wasm");

const _buildCache = memoAsyncByKey<string, WasmProver>();

/**
 * Build the circom witness calculator.
 *
 * `memorySize: 1` is required. By default `circom_runtime` allocates a
 * **2 GiB** `WebAssembly.Memory` (32767 pages) and on failure halves and
 * retries, logging a warning each round; on memory-constrained devices this
 * can get the tab killed.
 *
 * That memory is passed as `env.memory`, which only circom 1 modules import.
 * Both shipped circuits are circom 2: each exports its own `memory` and
 * `getVersion` (the circom 2 marker) and neither imports `env.memory`.
 */
async function buildWitnessCalculator(circuitWasm: Uint8Array): Promise<WitnessCalculator> {
    const { WitnessCalculatorBuilder } = await circomRuntime.get();
    return WitnessCalculatorBuilder(circuitWasm, { memorySize: 1 }) as Promise<WitnessCalculator>;
}

const circomRuntime = memoAsync(() =>
    (import("circom_runtime") as Promise<typeof CircomRuntimeT>).catch((e) => {
        throw new ProverUnavailableError(
            "WASM prover requested but `circom_runtime` is not installed. Add it to your app " +
                "dependencies (`npm i circom_runtime`).",
            { cause: e },
        );
    }),
);

export class WasmProver implements Prover {
    private constructor(
        private readonly session: ProverSession,
        private readonly wc: WitnessCalculator,
    ) {}

    /**
     * Build (or return the in-flight build for) a prover over `artifacts`.
     *
     * `opts` reaches the artifact fetch, so a caller can observe or abort the
     * ~48 MB zkey download. It applies only to the call that starts the
     * build: a second caller for the same artifacts joins the existing promise and
     * sees neither its progress nor its `signal`.
     */
    static async build(
        artifacts: ProverArtifacts,
        opts: LoadArtifactOpts = {},
    ): Promise<WasmProver> {
        assertUsable();
        // Canonicalised before use as a key, so different spellings of one
        // artifact pair (relative, root-relative, absolute) share one session
        // rather than each parsing a ~48 MB proving key into wasm memory.
        const canonical = resolveArtifacts(artifacts);
        const key = `${canonical.zkeyPath}\0${canonical.wasmPath}`;
        return _buildCache.get(key, () => WasmProver._doBuild(canonical, opts));
    }

    private static async _doBuild(paths: ProverPaths, opts: LoadArtifactOpts): Promise<WasmProver> {
        const [Session, zkeyBytes, wc] = await Promise.all([
            loadProver(),
            loadArtifactBytes(paths.zkeyPath, opts),
            // The witness calculator (~4 MB) arrives well before the zkey
            // (~48 MB), so it is compiled on arrival. Its progress is suppressed
            // because two downloads on one callback would report non-monotonic
            // progress.
            loadArtifactBytes(paths.wasmPath, { ...opts, onProgress: undefined }).then(
                buildWitnessCalculator,
            ),
        ]);
        const session = new Session(zkeyBytes);
        // The key is in wasm linear memory and `wc` holds a compiled module, so
        // these bytes are not read again. See `releaseArtifactBytes`.
        releaseArtifactBytes(paths.zkeyPath, paths.wasmPath);
        return new WasmProver(session, wc);
    }

    /**
     * Warm the wasm module to avoid first-prove latency. With `artifacts`,
     * also fetches + parses them (full `build`, cached).
     */
    static async preload(artifacts?: ProverArtifacts, opts: LoadArtifactOpts = {}): Promise<void> {
        assertUsable();
        if (artifacts) {
            await WasmProver.build(artifacts, opts);
            return;
        }
        await loadProver();
    }

    /**
     * Terminate the rayon worker pool and drop every cached prover.
     *
     * Not required for process exit (the workers are unref'd); provides a
     * deterministic teardown point for long-lived hosts and test suites.
     *
     * **Irreversible once a thread pool has started.** rayon's global pool is
     * initialised once per wasm module instance, and a re-import returns the
     * same instance with the terminated pool still registered. A second
     * `initThreadPool` throws (`unwrap_throw` on `PoolBuilder::build`), yet the
     * module still dispatches into the terminated pool, so `session.prove`
     * would block indefinitely.
     *
     * Subsequent `build()` or `preload()` calls therefore throw. Proving again
     * requires a fresh realm (a worker or child process).
     *
     * If no pool was started (single-threaded configuration), the module memo
     * is dropped and the next `build()` works normally.
     */
    static async shutdown(): Promise<void> {
        // Sampled before shutdown, after which the count is always 0.
        const hadPool = rayonWorkerCount() > 0;
        _buildCache.clear();
        await shutdownRayonWorkers();
        if (hadPool) _shutDownWithPool = true;
        else resetProverModule();
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

/**
 * Set by {@link WasmProver.shutdown} when it terminates a live thread pool.
 * See that method for why this is irreversible within the realm.
 */
let _shutDownWithPool = false;

function assertUsable(): void {
    if (_shutDownWithPool) {
        throw new ProverUnavailableError(
            "WasmProver.shutdown() terminated this realm's rayon thread pool, and the wasm " +
                "module cannot be reinitialised in place — prove in a fresh worker or process " +
                "instead of reusing this one",
        );
    }
}
