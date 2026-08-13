// Web Worker entry — runs `WasmProver` off the main thread.
//
// Spawn with `new Worker(new URL("@lelantos-org/sdk/prover-worker",
// import.meta.url), { type: "module" })` and wrap with `WorkerProver`.
// Caller owns termination.

import { getLogger } from "../log/logger.js";
import { timed } from "../log/timed.js";
import { serveWorkerRpc } from "../worker/serve.js";
import { configureArtifactCache } from "./artifacts.js";
import type { ProverPaths } from "./types.js";
import type { ProverMethods, WorkerSetup } from "./worker-protocol.js";

const log = getLogger("lelantos:prover:worker");

type Wasm = typeof import("./wasm-prover.js");

/**
 * Keyed on the artifact pair, not a single slot.
 *
 * A bare singleton would answer every later request with the prover built for
 * the *first* one — switch shape on a live `WorkerProver` and you would get
 * proofs from the wrong circuit, silently and with no error. `WasmProver.build`
 * memoises on the same key, so this map holds no additional provers; it exists
 * to make the lookup correct rather than to cache.
 */
const provers = new Map<string, Promise<import("./wasm-prover.js").WasmProver>>();

/** Realm-wide, and only meaningful on the first build — see `WorkerSetup`. */
let setupApplied = false;

function applySetup(wp: Wasm, setup: WorkerSetup): void {
    if (setupApplied) return;
    setupApplied = true;
    if (typeof setup.threads === "number") wp.configureProverThreads(setup.threads);
    // This realm has its own copy of the artifact-cache state, so the caller's
    // opt-out only lands if it is applied here as well.
    if (setup.cacheArtifacts === false) configureArtifactCache(false);
}

function getProver(
    paths: ProverPaths,
    setup: WorkerSetup,
): Promise<import("./wasm-prover.js").WasmProver> {
    const key = `${paths.zkeyPath}\0${paths.wasmPath}`;
    const hit = provers.get(key);
    if (hit) return hit;
    const built = (async () => {
        const wp = await import("./wasm-prover.js");
        applySetup(wp, setup);
        return wp.WasmProver.build(paths);
    })().catch((err) => {
        provers.delete(key);
        throw err;
    });
    provers.set(key, built);
    return built;
}

serveWorkerRpc<ProverMethods>(
    {
        async preload({ paths, ...setup }) {
            await timed(log, "preload.getProver", () => getProver(paths, setup));
        },

        async prove({ paths, input, ...setup }) {
            const p = await timed(log, "getProver", () => getProver(paths, setup));
            if (!input) throw new Error("prove request missing input");
            return timed(log, "prove", () => p.prove(input));
        },
    },
    { forwardLogs: true },
);
