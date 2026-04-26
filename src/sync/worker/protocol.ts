// Scanner worker wire types. Transport is `src/worker/` — this module owns
// only the payload shapes and their codecs.
//
// NO CLIENT-SIDE FMD PRE-FILTER
// -----------------------------
// The protocol carries no detection key or per-input clue: `/v1/notes` does
// not return `clue.R`, so the worker cannot FMD-reject before trial-decrypt.
// Adding one needs a wire change on fmd-webserver and is not clearly a win —
// γ=5 with early exit costs ~2 Baby-Jubjub scalar muls plus two Poseidon-6
// hashes per non-matching note, against one wasm call for trial-decrypt. FMD's
// payoff is server-side bandwidth, which `FmdMatchesNoteSource`
// (`syncStrategy: { kind: "matches" }`) already delivers.

import type { ScanHit, ScanInput } from "../scan.js";

/**
 * Wasm loader overrides forwarded on `init`. Required for bundlers that
 * rewrite `new URL(..., import.meta.url)` inside worker chunks — without it
 * the wasm load in the worker hangs silently.
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
}

export interface WireScanHit {
    asset: string;
    value: string;
    rho: string;
    rcm: string;
    rcvDep: string;
    cm: string;
    leafIndex: number;
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
    };
}

export function decodeInput(w: WireScanInput): ScanInput {
    return {
        ciphertext: w.ciphertext,
        epk: w.epk,
        cm: BigInt(w.cm),
        leafIndex: w.leafIndex,
    };
}

export function encodeHit(h: ScanHit): WireScanHit {
    return {
        asset: h.asset.toString(),
        value: h.value.toString(),
        rho: h.rho.toString(),
        rcm: h.rcm.toString(),
        rcvDep: h.rcvDep.toString(),
        cm: h.cm.toString(),
        leafIndex: h.leafIndex,
    };
}

export function decodeHit(w: WireScanHit): ScanHit {
    return {
        asset: BigInt(w.asset),
        value: BigInt(w.value),
        rho: BigInt(w.rho),
        rcm: BigInt(w.rcm),
        rcvDep: BigInt(w.rcvDep),
        cm: BigInt(w.cm),
        leafIndex: w.leafIndex,
    };
}

/**
 * Buffers to transfer rather than copy.
 *
 * ⚠️ These are the CALLER'S arrays, straight from `NoteSource.listNotes`.
 * Transferring detaches them, so a scan request consumes its inputs and can
 * never be re-sent. The pool must recycle a failed worker rather than retry
 * the request — a resend would scan zero-length ciphertexts and silently
 * report no hits.
 */
export function transferablesOf(inputs: WireScanInput[]): Transferable[] {
    const xs: Transferable[] = [];
    for (const i of inputs) {
        xs.push(i.ciphertext.buffer as Transferable);
        xs.push(i.epk.buffer as Transferable);
    }
    return xs;
}
