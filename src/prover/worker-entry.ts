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

/** Realm-wide, and only meaningful on the first build — see `WorkerSetup`. */
let setupApplied = false;

/**
 * The prover for `paths`.
 *
 * Deliberately unmemoised. `WasmProver.build` already keys its own cache on the
 * same artifact pair, so a second map would hold nothing extra while giving the
 * key two definitions that must agree. If they drift, a shape switch returns
 * proofs from the wrong circuit.
 */
async function getProver(
    paths: ProverPaths,
    setup: WorkerSetup,
): Promise<import("./wasm-prover.js").WasmProver> {
    const wp = await import("./wasm-prover.js");
    if (!setupApplied) {
        setupApplied = true;
        if (typeof setup.threads === "number") wp.configureProverThreads(setup.threads);
        // This realm has its own copy of the artifact-cache state, so the
        // caller's opt-out only lands if it is applied here as well.
        if (setup.cacheArtifacts === false) configureArtifactCache(false);
    }
    return wp.WasmProver.build(paths);
}

serveWorkerRpc<ProverMethods>(
    {
        async preload({ paths, ...setup }) {
            await timed(log, "preload.getProver", () => getProver(paths, setup));
        },

        async prove({ paths, input, ...setup }) {
            // Before `getProver`, which fetches and parses ~29 MB of
            // artifacts. Rejecting a malformed request after that work is
            // pure waste.
            if (!input) throw new Error("prove request missing input");
            const p = await timed(log, "getProver", () => getProver(paths, setup));
            return timed(log, "prove", () => p.prove(input));
        },
    },
    { forwardLogs: true },
);
