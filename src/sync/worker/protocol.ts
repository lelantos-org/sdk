// Scanner worker wire types. Transport is in `src/runtime/rpc/`; this module defines only the
// payload shapes and their codecs.
//
// Each input carries the published clue point `R`, which `scanNotes` compares with the clue it
// recomputes from an opened note. The protocol carries no detection key: the worker does not
// FMD-test before trial-decrypt. FMD filtering is server-side, through `FmdMatchesNoteSource`
// (`syncStrategy: { kind: "matches" }`).
//
// Bigints cross as decimal strings; byte arrays are transferred. A scan's tallies are plain
// counters and cross as they are.

import type { ScanHit, ScanInput, ScanStats } from "../scan.js";

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
    clueR: Uint8Array;
    cm: string;
    leafIndex: number;
    blockNumber: number;
}

export interface WireScanHit {
    asset: string;
    value: string;
    rho: string;
    rcm: string;
    d: string;
    cm: string;
    leafIndex: number;
    blockNumber: number;
    memo?: string | undefined;
}

export interface ScanParams {
    ivk: string;
    inputs: WireScanInput[];
}

export interface ScanResult {
    hits: WireScanHit[];
    /** Tallies over `ScanParams.inputs`. */
    stats: ScanStats;
}

/** Method table for the scanner worker. */
export type ScannerMethods = {
    init: { params: { wasm?: WireWasmConfig }; result: undefined };
    scan: { params: ScanParams; result: ScanResult };
};

export function encodeInput(i: ScanInput): WireScanInput {
    return {
        ciphertext: i.ciphertext,
        epk: i.epk,
        clueR: i.clueR,
        cm: i.cm.toString(),
        leafIndex: i.leafIndex,
        blockNumber: i.blockNumber,
    };
}

export function decodeInput(w: WireScanInput): ScanInput {
    return {
        ciphertext: w.ciphertext,
        epk: w.epk,
        clueR: w.clueR,
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
        d: h.d.toString(),
        cm: h.cm.toString(),
        leafIndex: h.leafIndex,
        blockNumber: h.blockNumber,
        memo: h.memo,
    };
}

export function decodeHit(w: WireScanHit): ScanHit {
    return {
        asset: BigInt(w.asset),
        value: BigInt(w.value),
        rho: BigInt(w.rho),
        rcm: BigInt(w.rcm),
        d: BigInt(w.d),
        cm: BigInt(w.cm),
        leafIndex: w.leafIndex,
        blockNumber: w.blockNumber,
        memo: w.memo,
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
        xs.push(i.clueR.buffer as Transferable);
    }
    return xs;
}
