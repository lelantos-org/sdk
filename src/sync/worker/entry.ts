// Scanner worker entrypoint.
//
// Crypto modules are imported dynamically so the worker can boot, install
// its handler, and report an init failure back to the client. Static
// imports would crash module evaluation before any diagnostic could leave
// the worker.
//
// Poseidon is not built here: there is no client-side FMD pre-filter (see
// `./protocol.ts`), and trial-decrypt alone produces the full hit set.

import type { WasmJubjub as WasmJubjubT } from "../../crypto/jubjub-wasm/index.js";
import { serveWorkerRpc } from "../../worker/serve.js";
import { decodeInput, encodeHit, type ScannerMethods, type WireWasmConfig } from "./protocol.js";

let jubPromise: Promise<WasmJubjubT> | null = null;

async function jub(): Promise<WasmJubjubT> {
    if (!jubPromise) {
        jubPromise = import("../../crypto/jubjub-wasm/index.js").then((m) => m.WasmJubjub.build());
    }
    return jubPromise;
}

async function applyWasmConfig(cfg: WireWasmConfig): Promise<void> {
    const m = await import("../../crypto/jubjub-wasm/index.js");
    m.configureJubjubWasm({
        loadModule: () => import(/* @vite-ignore */ cfg.jubjubModuleUrl) as any,
        wasm: cfg.jubjubWasmUrl,
    });
}

serveWorkerRpc<ScannerMethods>(
    {
        async init({ wasm }) {
            if (wasm) await applyWasmConfig(wasm);
            await jub();
        },

        async scan({ ivk, inputs }) {
            const [J, { scanNotes }] = await Promise.all([jub(), import("../scan.js")]);
            const hits = scanNotes(J, BigInt(ivk), inputs.map(decodeInput));
            return { hits: hits.map(encodeHit) };
        },
    },
    { forwardLogs: true },
);
