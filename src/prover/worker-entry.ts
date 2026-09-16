// Web Worker entry — runs `WasmProver` off the main thread.
//
// Spawn with `new Worker(new URL("@lelantos-org/sdk/workers/prover",
// import.meta.url), { type: "module" })` and wrap with `WorkerProver`. The
// caller owns termination.

import { InvalidArgumentError } from "../errors/config.js";
import { getLogger } from "../log/logger.js";
import { timed } from "../log/timed.js";
import { serveWorkerRpc } from "../runtime/rpc/serve.js";
import { configureArtifactCache } from "./artifact-bytes.js";
import { loadWasmProver } from "./load-wasm-prover.js";
import type { ProverPaths } from "./types.js";
import type { ProverMethods, WorkerSetup } from "./worker-protocol.js";

const log = getLogger("lelantos:prover:worker");

/** Realm-wide; applies only on the first build (see `WorkerSetup`). */
let setupApplied = false;

/**
 * The prover for `paths`.
 *
 * Not memoised here: `WasmProver.build` caches on the same artifact pair, and a
 * second cache key definition could diverge and return a prover for the wrong
 * circuit.
 */
async function getProver(
    paths: ProverPaths,
    setup: WorkerSetup,
): Promise<import("./wasm-prover.js").WasmProver> {
    const wp = await loadWasmProver();
    if (!setupApplied) {
        setupApplied = true;
        if (typeof setup.threads === "number") wp.configureProverThreads(setup.threads);
        // This realm has its own artifact-cache state, so the caller's opt-out
        // must be applied here as well.
        if (setup.cacheArtifacts === false) configureArtifactCache(false);
    }
    return wp.WasmProver.build({ circuit: paths.wasmPath, zkey: paths.zkeyPath });
}

serveWorkerRpc<ProverMethods>(
    {
        async preload({ paths, ...setup }) {
            await timed(log, "preload.getProver", () => getProver(paths, setup));
        },

        async prove({ paths, input, ...setup }) {
            // Validated before `getProver`, which fetches and parses ~52 MB of
            // artifacts.
            if (!input) {
                throw new InvalidArgumentError("prove request missing input", {
                    argument: "input",
                });
            }
            const p = await timed(log, "getProver", () => getProver(paths, setup));
            return timed(log, "prove", () => p.prove(input));
        },
    },
    { forwardLogs: true },
);
