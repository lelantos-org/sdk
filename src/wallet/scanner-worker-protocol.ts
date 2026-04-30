// Wire format between WorkerPoolScanner and the scanner-worker entry.
// Kept in its own module so both sides import from the same source.

import type { ScanInput, ScanHit } from "../sync";
import type { FmdDetectionKey } from "../fmd";

export interface InitReq {
    type: "init";
    id: number;
}

export interface InitRes {
    type: "init-res";
    id: number;
}

export interface ScanReq {
    type: "scan";
    id: number;
    ivk: string; // bigint as decimal string (postMessage-safe)
    inputs: WireScanInput[];
    detectionKey?: WireDetectionKey;
}

export interface ScanRes {
    type: "scan-res";
    id: number;
    hits: WireScanHit[];
}

export interface ScanErr {
    type: "scan-err";
    id: number;
    message: string;
}

export interface WireScanInput {
    ciphertext: Uint8Array;
    epk: Uint8Array;
    cm: string; // bigint decimal
    leafIndex: number;
    clue?: { R: Uint8Array; bits: Uint8Array; gamma: number };
}

export interface WireDetectionKey {
    x: string[];
}

export interface WireScanHit {
    asset: string;
    value: string;
    rho: string;
    rcm: string;
    cm: string;
    leafIndex: number;
}

export function encodeInput(i: ScanInput): WireScanInput {
    return {
        ciphertext: i.ciphertext,
        epk: i.epk,
        cm: i.cm.toString(),
        leafIndex: i.leafIndex,
        clue: i.clue ? { R: i.clue.R, bits: i.clue.bits, gamma: i.clue.gamma } : undefined,
    };
}

export function decodeInput(w: WireScanInput): ScanInput {
    return {
        ciphertext: w.ciphertext,
        epk: w.epk,
        cm: BigInt(w.cm),
        leafIndex: w.leafIndex,
        clue: w.clue,
    };
}

export function encodeDetection(dk: FmdDetectionKey | undefined): WireDetectionKey | undefined {
    return dk ? { x: dk.x.map(String) } : undefined;
}

export function decodeDetection(w: WireDetectionKey | undefined): FmdDetectionKey | undefined {
    return w ? { x: w.x.map(BigInt) } : undefined;
}

export function encodeHit(h: ScanHit): WireScanHit {
    return {
        asset: h.asset.toString(),
        value: h.value.toString(),
        rho: h.rho.toString(),
        rcm: h.rcm.toString(),
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
        cm: BigInt(w.cm),
        leafIndex: w.leafIndex,
    };
}

export function transferablesOf(inputs: WireScanInput[]): Transferable[] {
    const xs: Transferable[] = [];
    for (const i of inputs) {
        xs.push(i.ciphertext.buffer);
        xs.push(i.epk.buffer);
        if (i.clue) {
            xs.push(i.clue.R.buffer);
            xs.push(i.clue.bits.buffer);
        }
    }
    return xs;
}
