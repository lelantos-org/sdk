// Web Worker entry. Boots a `WasmJubjub` (cached) and runs `scanNotes` for
// each scan request via the fused decrypt + FMD WASM paths.
//
// Bundle this as a separate worker chunk in your app build:
//   new Worker(new URL("@lelantos-org/sdk/scanner-worker", import.meta.url),
//              { type: "module" })

import { WasmJubjub } from "../crypto/jubjub-wasm.js";
import { Poseidon } from "../crypto/poseidon.js";
import { scanNotes } from "../sync.js";
import {
    decodeDetection,
    decodeInput,
    encodeHit,
    type InitReq,
    type InitRes,
    type ScanErr,
    type ScanReq,
    type ScanRes,
} from "./scanner-worker-protocol.js";

let jubPromise: Promise<WasmJubjub> | null = null;
function jub(): Promise<WasmJubjub> {
    if (!jubPromise) jubPromise = WasmJubjub.build();
    return jubPromise;
}

let posPromise: Promise<Poseidon> | null = null;
function pos(): Promise<Poseidon> {
    if (!posPromise) posPromise = Poseidon.build();
    return posPromise;
}

const ctx: { onmessage: ((ev: { data: unknown }) => void) | null } = globalThis as unknown as {
    onmessage: ((ev: { data: unknown }) => void) | null;
};

const post = (msg: ScanRes | ScanErr | InitRes): void => {
    (globalThis as unknown as { postMessage: (m: unknown) => void }).postMessage(msg);
};

ctx.onmessage = async (ev: { data: unknown }): Promise<void> => {
    const msg = ev.data as InitReq | ScanReq;
    if (!msg) return;

    if (msg.type === "init") {
        await Promise.all([jub(), pos()]);
        post({ type: "init-res", id: msg.id });
        return;
    }

    if (msg.type === "scan") {
        try {
            const [J, P] = await Promise.all([jub(), pos()]);
            const ivk = BigInt(msg.ivk);
            const inputs = msg.inputs.map(decodeInput);
            const dk = decodeDetection(msg.detectionKey);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const hits = scanNotes(J as any, P, ivk, inputs, dk);
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
