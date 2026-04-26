// Web Worker entry — runs `WasmProver` off the main thread.
//
// Spawn with `new Worker(new URL("@lelantos-org/sdk/prover-worker",
// import.meta.url), { type: "module" })` and wrap with `WorkerProver`.
// Caller owns termination.

import { getLogger } from "../log/logger.js";
import { timed } from "../log/timed.js";
import { serveWorkerRpc } from "../worker/serve.js";
import type { ProverPaths } from "./types.js";
import type { ProverMethods } from "./worker-protocol.js";

const log = getLogger("lelantos:prover:worker");

let cached: import("./wasm-prover.js").WasmProver | null = null;
let buildPromise: Promise<import("./wasm-prover.js").WasmProver> | null = null;

async function getProver(
    paths: ProverPaths,
    threads?: number,
): Promise<import("./wasm-prover.js").WasmProver> {
    if (cached) return cached;
    if (!buildPromise) {
        buildPromise = (async () => {
            const wp = await import("./wasm-prover.js");
            if (typeof threads === "number") wp.configureProverThreads(threads);
            return wp.WasmProver.build(paths);
        })();
    }
    cached = await buildPromise;
    return cached;
}

serveWorkerRpc<ProverMethods>(
    {
        async preload({ paths, threads }) {
            await timed(log, "preload.getProver", () => getProver(paths, threads));
        },

        async prove({ paths, input, threads }) {
            const p = await timed(log, "getProver", () => getProver(paths, threads));
            if (!input) throw new Error("prove request missing input");
            return timed(log, "prove", () => p.prove(input));
        },
    },
    { forwardLogs: true },
);
