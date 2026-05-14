// Crypto modules are dynamically imported so the worker can boot, install its
// `onmessage` handler, and reply with `init-err` on failure. Static imports
// would crash module eval before any diagnostic could leave the worker.
//
// Poseidon is skipped on this path: `circomlibjs` pulls CJS `blake2b` which
// Vite's worker pre-bundle can't shim. `scanNotes` only uses Poseidon inside
// `fmdTest`, so we pass `undefined` to skip the FMD fast-path. Trial-decrypt
// still produces the correct hit set.
import type { WasmJubjub as WasmJubjubT } from "../crypto/jubjub-wasm.js";
import {
    decodeInput,
    encodeHit,
    type InitErr,
    type InitReq,
    type InitRes,
    type ScanErr,
    type ScanReq,
    type ScanRes,
} from "./scanner-worker-protocol.js";

let jubPromise: Promise<WasmJubjubT> | null = null;
async function jub(): Promise<WasmJubjubT> {
    if (!jubPromise) {
        jubPromise = import("../crypto/jubjub-wasm.js").then((m) => m.WasmJubjub.build());
    }
    return jubPromise;
}

async function configureWasm(jubjubModuleUrl: string, jubjubWasmUrl: string): Promise<void> {
    const m = await import("../crypto/jubjub-wasm.js");
    m.configureJubjubWasm({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        loadModule: () => import(/* @vite-ignore */ jubjubModuleUrl) as any,
        wasm: jubjubWasmUrl,
    });
}

const ctx: { onmessage: ((ev: { data: unknown }) => void) | null } = globalThis as unknown as {
    onmessage: ((ev: { data: unknown }) => void) | null;
};

const post = (msg: ScanRes | ScanErr | InitRes | InitErr): void => {
    (globalThis as unknown as { postMessage: (m: unknown) => void }).postMessage(msg);
};

ctx.onmessage = async (ev: { data: unknown }): Promise<void> => {
    const msg = ev.data as InitReq | ScanReq;
    if (!msg) return;

    if (msg.type === "init") {
        try {
            if (msg.wasm) {
                await configureWasm(msg.wasm.jubjubModuleUrl, msg.wasm.jubjubWasmUrl);
            }
            await jub();
            post({ type: "init-res", id: msg.id });
        } catch (e) {
            post({
                type: "init-err",
                id: msg.id,
                message: e instanceof Error ? e.message : String(e),
            });
        }
        return;
    }

    if (msg.type === "scan") {
        try {
            const [J, { scanNotes }] = await Promise.all([jub(), import("../sync.js")]);
            const ivk = BigInt(msg.ivk);
            const inputs = msg.inputs.map(decodeInput);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const hits = scanNotes(J as any, undefined as any, ivk, inputs, undefined);
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
