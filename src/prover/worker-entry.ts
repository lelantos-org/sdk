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

let cached: import("./wasm-prover.js").WasmProver | null = null;
let buildPromise: Promise<import("./wasm-prover.js").WasmProver> | null = null;

async function getProver(
    paths: ProverPaths,
    setup: WorkerSetup,
): Promise<import("./wasm-prover.js").WasmProver> {
    if (cached) return cached;
    if (!buildPromise) {
        buildPromise = (async () => {
            const wp = await import("./wasm-prover.js");
            if (typeof setup.threads === "number") wp.configureProverThreads(setup.threads);
            // This realm has its own copy of the artifact-cache state, so the
            // caller's opt-out only lands if it is applied here as well.
            if (setup.cacheArtifacts === false) configureArtifactCache(false);
            return wp.WasmProver.build(paths);
        })();
    }
    cached = await buildPromise;
    return cached;
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
