// WASM-backed Groth16 prover. Drop-in for `SnarkjsProver`.
// Witness calc via `circom_runtime`; proof via rust ark-groth16 at
// `sdk/wasm/prover/`, with rayon multi-threading on COI pages.
//
// The loader and its configuration hooks live in `./wasm-loader.ts`, which
// carries no `circom_runtime` dependency — see the header there.

import { WitnessCalculatorBuilder } from "circom_runtime";
import { ProverError } from "../core/errors.js";
import { toAbsoluteUrl } from "../core/url.js";
import { getLogger } from "../log/logger.js";
import { timed, timedSync } from "../log/timed.js";
import { rayonWorkerCount, shutdownRayonWorkers } from "../wasm/rayon/index.js";
import { type LoadArtifactOpts, loadArtifactBytes, releaseArtifactBytes } from "./artifacts.js";
import type { Groth16Proof, ProveResult, Prover, ProverPaths } from "./types.js";
import { loadProver, type ProverSession, resetProverModule } from "./wasm-loader.js";

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

/**
 * Build the circom witness calculator.
 *
 * `memorySize: 1` is load-bearing. Left to its default, `circom_runtime`
 * allocates a **2 GiB** `WebAssembly.Memory` (32767 pages), and on failure
 * halves and retries — 1 GiB, 512 MB, … — logging a warning each round. On a
 * phone already holding a ~29 MB proving key that is a plausible cause of the
 * tab being killed.
 *
 * The allocation is pure waste here: it is handed to the module as `env.memory`,
 * but circom 2 modules own and export their own memory and do not import it.
 * Verified against both shipped circuits — each exports `memory`, neither
 * imports `env.memory`, both export `getVersion` (the circom 2 marker). Only
 * the circom 1 path would consume it.
 */
function buildWitnessCalculator(circuitWasm: Uint8Array): Promise<WitnessCalculator> {
    return WitnessCalculatorBuilder(circuitWasm, { memorySize: 1 }) as Promise<WitnessCalculator>;
}

export class WasmProver implements Prover {
    private constructor(
        private readonly session: ProverSession,
        private readonly wc: WitnessCalculator,
    ) {}

    /**
     * Build (or return the in-flight build for) a prover over `paths`.
     *
     * `opts` reaches the artifact fetch, so a caller can observe or abort the
     * ~29 MB zkey download. It applies only to the call that starts the
     * build: a second caller for the same paths joins the existing promise and
     * sees neither its progress nor its `signal`.
     */
    static async build(paths: ProverPaths, opts: LoadArtifactOpts = {}): Promise<WasmProver> {
        assertUsable();
        // Canonicalised before it is used as a key or passed on. Two spellings
        // of one artifact pair — `"artifacts/x.zkey"`, `"/artifacts/x.zkey"`,
        // the absolute href — otherwise build two sessions, i.e. two ~29 MB
        // proving keys parsed into wasm memory, even though `loadArtifactBytes`
        // correctly serves both from a single download.
        const canonical: ProverPaths = {
            zkeyPath: toAbsoluteUrl(paths.zkeyPath),
            wasmPath: toAbsoluteUrl(paths.wasmPath),
        };
        const key = `${canonical.zkeyPath}\0${canonical.wasmPath}`;
        const cached = _buildCache.get(key);
        if (cached) return cached;
        const p = WasmProver._doBuild(canonical, opts).catch((err) => {
            _buildCache.delete(key);
            throw err;
        });
        _buildCache.set(key, p);
        return p;
    }

    private static async _doBuild(paths: ProverPaths, opts: LoadArtifactOpts): Promise<WasmProver> {
        const [Session, zkeyBytes, wc] = await Promise.all([
            loadProver(),
            loadArtifactBytes(paths.zkeyPath, opts),
            // The witness calculator is ~4 MB against the zkey's ~49, so it
            // lands far earlier — compile it as soon as it arrives rather than
            // waiting on the barrel. Its progress is suppressed because
            // reporting both through one callback makes the bar jump backwards.
            loadArtifactBytes(paths.wasmPath, { ...opts, onProgress: undefined }).then(
                buildWitnessCalculator,
            ),
        ]);
        const session = new Session(zkeyBytes);
        // The key now lives in wasm linear memory and `wc` holds a compiled
        // module, so nothing reads these bytes again. See `releaseArtifactBytes`
        // for why this is the caller's call and not a global policy.
        releaseArtifactBytes(paths.zkeyPath, paths.wasmPath);
        return new WasmProver(session, wc);
    }

    /**
     * Warm the wasm module to avoid first-prove latency. With `paths`,
     * also fetches + parses the artifacts (full `build`, cached).
     */
    static async preload(paths?: ProverPaths, opts: LoadArtifactOpts = {}): Promise<void> {
        assertUsable();
        if (paths) {
            await WasmProver.build(paths, opts);
            return;
        }
        await loadProver();
    }

    /**
     * Terminate the rayon worker pool and drop every cached prover.
     *
     * Not needed for a process to exit — the workers are unref'd — but gives
     * long-lived hosts and test suites a deterministic teardown point.
     *
     * **This is a one-way door once a thread pool has started.** rayon's global
     * pool is initialised once per wasm module instance, and the module cannot
     * be replaced: a re-import returns the same instance from the runtime's
     * module registry, with the same linear memory and the same now-dead pool
     * registered in it. A second `initThreadPool` throws
     * (`unwrap_throw` on `PoolBuilder::build`) and falls back to
     * single-threaded, but the fallback does not help — the module still
     * dispatches into the dead pool, so `session.prove` blocks on a latch no
     * live thread will ever signal.
     *
     * A further `build()` or `preload()` therefore throws rather than
     * returning a prover that hangs on first use. A host needing to prove
     * again after reclaiming this memory requires a fresh realm — a worker or
     * a child process.
     *
     * When no pool was ever started (single-threaded by configuration) nothing
     * is poisoned, so the module memo is simply dropped and the next `build()`
     * works normally.
     */
    static async shutdown(): Promise<void> {
        // Sampled before the workers go: afterwards the count is always 0.
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
 * Set by {@link WasmProver.shutdown} when it tore down a live thread pool.
 * See that method for why this cannot be undone in the same realm.
 */
let _shutDownWithPool = false;

function assertUsable(): void {
    if (_shutDownWithPool) {
        throw new ProverError(
            "WasmProver.shutdown() terminated this realm's rayon thread pool, and the wasm " +
                "module cannot be reinitialised in place — prove in a fresh worker or process " +
                "instead of reusing this one",
        );
    }
}
