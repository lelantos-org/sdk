// Scanner worker entrypoint.
//
// Crypto modules are imported dynamically so the worker can boot, install
// its handler, and report an init failure back to the client. Static
// imports would crash module evaluation before any diagnostic could leave
// the worker.
//
// Poseidon is built alongside Jubjub only for the per-hit commitment check in
// `scanNotes`, not for a client-side FMD pre-filter (see `./protocol.ts`). An
// FMD filter would run per input; the commitment check runs per hit.

import { memoAsync } from "../../core/async.js";
import type { Jubjub as JubjubT } from "../../crypto/jubjub-wasm/index.js";
import type { Poseidon as PoseidonT } from "../../crypto/poseidon.js";
import { serveWorkerRpc } from "../../runtime/rpc/serve.js";
import { decodeInput, encodeHit, type ScannerMethods, type WireWasmConfig } from "./protocol.js";

// Both memoised with eviction on rejection, so a transient import or wasm
// failure does not permanently disable this worker.
const jubjub = memoAsync<JubjubT>(() =>
    import("../../crypto/jubjub-wasm/index.js").then((m) => m.Jubjub.build()),
);
const poseidon = memoAsync<PoseidonT>(() =>
    import("../../crypto/poseidon.js").then((m) => m.Poseidon.build()),
);

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
            await Promise.all([jubjub.get(), poseidon.get()]);
        },

        async scan({ ivk, inputs }) {
            const [J, P, { scanNotes }] = await Promise.all([
                jubjub.get(),
                poseidon.get(),
                import("../scan.js"),
            ]);
            const hits = scanNotes(J, P, BigInt(ivk), inputs.map(decodeInput));
            return { hits: hits.map(encodeHit) };
        },
    },
    { forwardLogs: true },
);
