// Wire-format (de)serializers for the relayer HTTP protocol. Split out of
// `relayer.ts` so the client surface stays focused on transport.

import type { Field, Point } from "./crypto/index.js";
import type { AuxOutput } from "./permit2.js";
import type {
    ScannedNote,
    SubmitIntentPayload,
    SubmitSwapPayload,
    SubmitTransactPayload,
    SwapBlob,
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

export function serializeSubmitTransact(p: SubmitTransactPayload): unknown {
    return {
        chainId: Number(p.chainId),
        kind: p.kind,
        proof2x2: p.proof2x2,
        pubInputs: serializePubInputs(p.pubInputs),
        aux: p.aux.map(serializeAux),
    };
}

export function serializeSubmitSwap(p: SubmitSwapPayload): unknown {
    return {
        chainId: Number(p.chainId),
        proof2x2: p.proof2x2,
        pubInputs: serializePubInputs(p.pubInputs),
        aux: p.aux.map(serializeAux),
        swap: serializeSwapBlob(p.swap),
    };
}

function serializeSwapBlob(s: SwapBlob): unknown {
    return {
        adapter: s.adapter,
        route: s.route,
        intentD: {
            // Rust `DepositIntentDto` declares these as `u64`; serde
            // rejects strings. JS Number is safe for uint64 up to 2^53,
            // which covers every practical chainId / asset id / publicIn.
            chainId: Number(s.intentD.chainId),
            publicAssetId: Number(s.intentD.publicAssetId),
            publicIn: Number(s.intentD.publicIn),
            payer: s.intentD.payer,
            recipient: s.intentD.recipient,
            outCm: s.intentD.outCm,
        },
        auxD: s.auxD.map(serializeAux),
        tokenIn: s.tokenIn,
        tokenOut: s.tokenOut,
        // Rust DTO wires `amountIn`/`minOut` as decimal `String` so
        // U256 values >2^53 round-trip safely.
        amountIn: s.amountIn.toString(),
        minOut: s.minOut.toString(),
    };
}

export function serializeSubmitIntent(p: SubmitIntentPayload): unknown {
    return {
        chainId: Number(p.chainId),
        intent: {
            chainId: p.intent.chainId.toString(),
            publicAssetId: p.intent.publicAssetId.toString(),
            publicIn: p.intent.publicIn.toString(),
            payer: p.intent.payer,
            recipient: p.intent.recipient,
            outCm: p.intent.outCm,
        },
        permit2: {
            nonce: p.permit2.nonce.toString(),
            deadline: p.permit2.deadline.toString(),
            maxTotal: p.permit2.maxTotal.toString(),
            signature: p.permit2.signature,
        },
        aux: p.aux.map(serializeAuxOutput),
    };
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
        publicIn: Number(pi.publicIn),
        publicOut: Number(pi.publicOut),
        inCv: pi.inCv.map(pointToObj),
        outCv: pi.outCv.map(pointToObj),
        recipient: pi.recipient,
        chainId: Number(pi.chainId),
        payer: pi.payer,
        relayer: pi.relayer,
        outCvDep: pi.outCvDep.map(pointToObj),
    };
}

function serializeAux(a: TransactAux): unknown {
    return {
        clueR: pointToObj(a.clueR),
        ephPub: pointToObj(a.ephPub),
        ciphertext: bytesToHex(a.ciphertext),
    };
}

function serializeAuxOutput(a: AuxOutput): unknown {
    return {
        clueRx: a.clueRx.toString(),
        clueRy: a.clueRy.toString(),
        ephPubX: a.ephPubX.toString(),
        ephPubY: a.ephPubY.toString(),
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
