// Node worker_threads bootstrap for wasm-bindgen-rayon. Spawned by
// `installNodeRayonWorker` in `./node-worker.ts`. Implements the
// wasm-bindgen-rayon worker protocol:
//   main → worker: { type:'wasm_bindgen_worker_init', init, receiver }
//   worker → main: { type:'wasm_bindgen_worker_ready' }
//   worker calls pkg.wbg_rayon_start_worker(receiver) which blocks the
//   rayon dispatcher inside wasm via Atomics.wait.
//
// Stays as a static .mjs asset (copied to `dist/wasm/rayon/` by the build) so the
// runtime does not have to materialise a temp file on disk.

import { parentPort, threadId } from "node:worker_threads";

// This file runs BEFORE any SDK module loads, so it cannot use the logger.
// `LELANTOS_DEBUG` is the one documented exception to the logging config —
// see `log/env.ts`.
const dbg = (m) => {
    if (process.env.LELANTOS_DEBUG || process.env.LELANTOS_RAYON_DEBUG) {
        console.error(`[lelantos:wasm:rayon worker ${threadId}]`, m);
    }
};

// Stub browser-Worker globals so workerHelpers.js (loaded transitively by
// pkg/prover.js) does not ReferenceError. We don't route messages through
// these — the bootstrap talks to parentPort directly per the rayon protocol.
globalThis.self = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.postMessage = () => {};

const pkgUrl = process.env.LELANTOS_RAYON_PKG_URL;
if (!pkgUrl) throw new Error("LELANTOS_RAYON_PKG_URL missing");

dbg("waiting init");
parentPort.once("message", async (data) => {
    try {
        dbg(`got ${data && data.type}`);
        if (data?.type !== "wasm_bindgen_worker_init") return;
        const pkg = await import(pkgUrl);
        await pkg.default(data.init);
        dbg("wasm initialized; posting ready");
        parentPort.postMessage({ type: "wasm_bindgen_worker_ready" });
        pkg.wbg_rayon_start_worker(data.receiver);
        dbg("start_worker returned");
    } catch (err) {
        dbg(`worker error: ${(err && err.stack) || err}`);
        throw err;
    }
});
