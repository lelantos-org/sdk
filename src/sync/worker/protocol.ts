// Scanner worker wire types. Transport is in `src/runtime/rpc/`; this module defines only the
// payload shapes and their codecs.
//
// The protocol carries no detection key or per-input clue: `/v1/notes` does not return `clue.R`,
// so the worker cannot FMD-reject before trial-decrypt. FMD filtering is server-side, through
// `FmdMatchesNoteSource` (`syncStrategy: { kind: "matches" }`).

import type { ScanHit, ScanInput } from "../scan.js";

/**
 * Wasm loader overrides forwarded on `init`. Required for bundlers that rewrite
 * `new URL(..., import.meta.url)` inside worker chunks; without it the worker's wasm load hangs
 * silently.
 */
export interface WireWasmConfig {
    jubjubModuleUrl: string;
    jubjubWasmUrl: string;
}

export interface WireScanInput {
    ciphertext: Uint8Array;
    epk: Uint8Array;
    cm: string;
    leafIndex: number;
    blockNumber: number;
}

export interface WireScanHit {
    asset: string;
    value: string;
    rho: string;
    rcm: string;
    cm: string;
    leafIndex: number;
    blockNumber: number;
}

export interface ScanParams {
    ivk: string;
    inputs: WireScanInput[];
}

/** Method table for the scanner worker. */
export type ScannerMethods = {
    init: { params: { wasm?: WireWasmConfig }; result: undefined };
    scan: { params: ScanParams; result: { hits: WireScanHit[] } };
};

export function encodeInput(i: ScanInput): WireScanInput {
    return {
        ciphertext: i.ciphertext,
        epk: i.epk,
        cm: i.cm.toString(),
        leafIndex: i.leafIndex,
        blockNumber: i.blockNumber,
    };
}

export function decodeInput(w: WireScanInput): ScanInput {
    return {
        ciphertext: w.ciphertext,
        epk: w.epk,
        cm: BigInt(w.cm),
        leafIndex: w.leafIndex,
        blockNumber: w.blockNumber,
    };
}

export function encodeHit(h: ScanHit): WireScanHit {
    return {
        asset: h.asset.toString(),
        value: h.value.toString(),
        rho: h.rho.toString(),
        rcm: h.rcm.toString(),
        cm: h.cm.toString(),
        leafIndex: h.leafIndex,
        blockNumber: h.blockNumber,
    };
}

export function decodeHit(w: WireScanHit): ScanHit {
    return {
        asset: BigInt(w.asset),
        value: BigInt(w.value),
        rho: BigInt(w.rho),
        rcm: BigInt(w.rcm),
        cm: BigInt(w.cm),
        leafIndex: w.leafIndex,
        blockNumber: w.blockNumber,
    };
}

/**
 * Buffers to transfer rather than copy. Transferring detaches the caller's arrays, so a scan
 * request cannot be re-sent; see `WorkerPoolScanner.recycle`.
 */
export function transferablesOf(inputs: WireScanInput[]): Transferable[] {
    const xs: Transferable[] = [];
    for (const i of inputs) {
        xs.push(i.ciphertext.buffer as Transferable);
        xs.push(i.epk.buffer as Transferable);
    }
    return xs;
}
