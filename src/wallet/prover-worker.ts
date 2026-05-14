// Web Worker entry — runs `WasmProver` off the main thread.
//
// Spawn with `new Worker(new URL("@lelantos-org/sdk/prover-worker", import.meta.url),
// { type: "module" })` and wrap with `WorkerProver`. Caller owns termination.

import type { ProverPaths } from "../prover.js";

interface ProveReq {
    type: "prove";
    id: number;
    paths: ProverPaths;
    input: Record<string, unknown>;
    /// Pin rayon thread count. Only honoured on the FIRST request; pool
    /// is then reused across subsequent requests.
    threads?: number;
}

interface PreloadReq {
    type: "preload";
    id: number;
    paths: ProverPaths;
    threads?: number;
}

type Req = ProveReq | PreloadReq;

interface ProveOk {
    type: "prove-res";
    id: number;
    result: import("../prover.js").ProveResult;
}

interface PreloadOk {
    type: "preload-res";
    id: number;
}

interface ProveErr {
    type: "error";
    id: number;
    message: string;
}

declare const self: {
    onmessage: ((ev: MessageEvent<Req>) => void) | null;
    postMessage(msg: ProveOk | PreloadOk | ProveErr): void;
};

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

/// Per-phase timing log. Disable via `globalThis.__lelantos_prover_perf = false`.
const PERF = (globalThis as { __lelantos_prover_perf?: boolean }).__lelantos_prover_perf !== false;
const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`);
async function timed<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
    if (!PERF) return fn();
    const t0 = performance.now();
    try {
        return await fn();
    } finally {
        // eslint-disable-next-line no-console
        console.log(`[worker-perf] ${label}: ${fmt(performance.now() - t0)}`);
    }
}

self.onmessage = async (ev) => {
    const msg = ev.data;
    try {
        if (msg.type === "preload") {
            await timed("preload.getProver", () => getProver(msg.paths, msg.threads));
            self.postMessage({ type: "preload-res", id: msg.id });
            return;
        }
        if (msg.type === "prove") {
            const p = await timed("getProver", () => getProver(msg.paths, msg.threads));
            if (!msg.input) throw new Error("prove req missing input");
            const result = await timed("prove", () => p.prove(msg.input));
            self.postMessage({ type: "prove-res", id: msg.id, result });
            return;
        }
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        self.postMessage({ type: "error", id: msg.id, message });
    }
};
