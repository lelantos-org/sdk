// Web Worker entry. Boots a `WasmJubjub` (cached) and runs `scanNotes` for
// each scan request via the fused decrypt + FMD WASM paths.
//
// Bundle this as a separate worker chunk in your app build:
//   new Worker(new URL("@lelantos/sdk/scanner-worker", import.meta.url),
//              { type: "module" })

import { WasmJubjub } from "../crypto/jubjub-wasm";
import { scanNotes } from "../sync";
import {
    decodeInput,
    decodeDetection,
    encodeHit,
    type InitReq,
    type InitRes,
    type ScanReq,
    type ScanRes,
    type ScanErr,
} from "./scanner-worker-protocol";

let jubPromise: Promise<WasmJubjub> | null = null;
function jub(): Promise<WasmJubjub> {
    if (!jubPromise) jubPromise = WasmJubjub.build();
    return jubPromise;
}

const ctx: { onmessage: ((ev: { data: unknown }) => void) | null } =
    globalThis as unknown as { onmessage: ((ev: { data: unknown }) => void) | null };

const post = (msg: ScanRes | ScanErr | InitRes): void => {
    (globalThis as unknown as { postMessage: (m: unknown) => void }).postMessage(msg);
};

ctx.onmessage = async (ev: { data: unknown }): Promise<void> => {
    const msg = ev.data as InitReq | ScanReq;
    if (!msg) return;

    if (msg.type === "init") {
        await jub();
        post({ type: "init-res", id: msg.id });
        return;
    }

    if (msg.type === "scan") {
        try {
            const J = await jub();
            const ivk = BigInt(msg.ivk);
            const inputs = msg.inputs.map(decodeInput);
            const dk = decodeDetection(msg.detectionKey);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const hits = scanNotes(J as any, ivk, inputs, dk);
            post({ type: "scan-res", id: msg.id, hits: hits.map(encodeHit) });
        } catch (e) {
            post({
                type: "scan-err",
                id: msg.id,
                message: e instanceof Error ? e.message : String(e),
            });
        }
    }
};
