// Wire-format (de)serializers for the relayer HTTP protocol. Split out of
// `relayer.ts` so the client surface stays focused on transport.

import type { Field, Point } from "./crypto/index.js";
import type {
    ScannedNote,
    SubmitTransactPayload,
    TransactAux,
    TransactPubInputs,
} from "./relayer.js";

export interface SerializedScannedNote {
    ciphertext: string; // hex
    clueR: [string, string];
    ephPub: [string, string];
    cm: string;
    leafIndex: number;
}

export interface SerializedMerkleProof {
    leafIndex: number;
    pathElements: string[][];
    pathIndices: number[];
    root: string;
}

export interface SerializedTreeState {
    leafCount: number;
    root: string;
    frontier: string[][];
}

export function serializeSubmit(p: SubmitTransactPayload): unknown {
    const out: Record<string, unknown> = {
        chainId: Number(p.chainId),
        proof2x2: p.proof2x2,
        pubInputs: serializePubInputs(p.pubInputs),
        aux: p.aux.map(serializeAux),
    };
    if (p.permit) {
        out.permit = {
            value: p.permit.value,
            deadline: p.permit.deadline,
            v: p.permit.v,
            r: p.permit.r,
            s: p.permit.s,
        };
    }
    if (p.bridge) out.bridge = p.bridge;
    return out;
}

export function deserializeScannedNote(s: SerializedScannedNote): ScannedNote {
    return {
        ciphertext: hexToBytes(s.ciphertext),
        clueR: [BigInt(s.clueR[0]), BigInt(s.clueR[1])] as Point,
        ephPub: [BigInt(s.ephPub[0]), BigInt(s.ephPub[1])] as Point,
        cm: BigInt(s.cm),
        leafIndex: s.leafIndex,
    };
}

export function deserializeMerkleProof(d: SerializedMerkleProof): {
    leafIndex: number;
    pathElements: Field[][];
    pathIndices: number[];
    root: Field;
} {
    return {
        leafIndex: d.leafIndex,
        pathElements: d.pathElements.map((lvl) => lvl.map(BigInt)),
        pathIndices: d.pathIndices,
        root: BigInt(d.root),
    };
}

export function deserializeTreeState(d: SerializedTreeState): {
    leafCount: number;
    root: Field;
    frontier: Field[][];
} {
    return {
        leafCount: d.leafCount,
        root: BigInt(d.root),
        frontier: d.frontier.map((lvl) => lvl.map(BigInt)),
    };
}

function pointToObj(p: Point): { x: string; y: string } {
    return { x: p[0].toString(), y: p[1].toString() };
}

function serializePubInputs(pi: TransactPubInputs): unknown {
    return {
        merkleRoot: pi.merkleRoot.toString(),
        nullifier: pi.nullifier.map((n) => n.toString()),
        outCm: pi.outCm.map((c) => c.toString()),
        publicAssetId: Number(pi.publicAssetId),
        pubAssetGen: pointToObj(pi.pubAssetGen),
        publicIn: Number(pi.publicIn),
        publicOut: Number(pi.publicOut),
        inCv: pi.inCv.map(pointToObj),
        outCv: pi.outCv.map(pointToObj),
        recipient: pi.recipient,
        chainId: Number(pi.chainId),
        payer: pi.payer,
        relayer: pi.relayer,
    };
}

function serializeAux(a: TransactAux): unknown {
    return {
        clueR: pointToObj(a.clueR),
        ephPub: pointToObj(a.ephPub),
        ciphertext: bytesToHex(a.ciphertext),
    };
}

function bytesToHex(b: Uint8Array): string {
    let h = "0x";
    for (const x of b) h += x.toString(16).padStart(2, "0");
    return h;
}

function hexToBytes(h: string): Uint8Array {
    const s = h.startsWith("0x") ? h.slice(2) : h;
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
    return out;
}
