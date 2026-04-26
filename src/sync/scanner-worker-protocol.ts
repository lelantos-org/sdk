import type { FmdDetectionKey } from "../fmd/fmd.js";
import type { ScanHit, ScanInput } from "./sync.js";

/** @internal */
export interface InitReq {
    type: "init";
    id: number;
    wasm?: WireWasmConfig;
}

/** @internal */
export interface WireWasmConfig {
    jubjubModuleUrl: string;
    jubjubWasmUrl: string;
}

/** @internal */
export interface InitRes {
    type: "init-res";
    id: number;
}

/** @internal */
export interface InitErr {
    type: "init-err";
    id: number;
    message: string;
}

/** @internal */
export interface ScanReq {
    type: "scan";
    id: number;
    ivk: string;
    inputs: WireScanInput[];
    detectionKey?: WireDetectionKey;
}

/** @internal */
export interface ScanRes {
    type: "scan-res";
    id: number;
    hits: WireScanHit[];
}

/** @internal */
export interface ScanErr {
    type: "scan-err";
    id: number;
    message: string;
}

/** @internal */
export interface WireScanInput {
    ciphertext: Uint8Array;
    epk: Uint8Array;
    cm: string;
    leafIndex: number;
    clue?: { R: Uint8Array; bits: Uint8Array; gamma: number };
}

/** @internal */
export interface WireDetectionKey {
    x: string[];
}

/** @internal */
export interface WireScanHit {
    asset: string;
    value: string;
    rho: string;
    rcm: string;
    rcvDep: string;
    cm: string;
    leafIndex: number;
}

/** @internal */
export function encodeInput(i: ScanInput): WireScanInput {
    return {
        ciphertext: i.ciphertext,
        epk: i.epk,
        cm: i.cm.toString(),
        leafIndex: i.leafIndex,
        clue: i.clue ? { R: i.clue.R, bits: i.clue.bits, gamma: i.clue.gamma } : undefined,
    };
}

/** @internal */
export function decodeInput(w: WireScanInput): ScanInput {
    return {
        ciphertext: w.ciphertext,
        epk: w.epk,
        cm: BigInt(w.cm),
        leafIndex: w.leafIndex,
        clue: w.clue,
    };
}

/** @internal */
export function encodeDetection(dk: FmdDetectionKey | undefined): WireDetectionKey | undefined {
    return dk ? { x: dk.x.map(String) } : undefined;
}

/** @internal */
export function decodeDetection(w: WireDetectionKey | undefined): FmdDetectionKey | undefined {
    return w ? { x: w.x.map(BigInt) } : undefined;
}

/** @internal */
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

/** @internal */
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

/** @internal */
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
