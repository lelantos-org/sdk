// Wallet-side HTTP client for the off-chain MASP relayer service.
//
// Lazy-root model: the relayer holds the canonical commitment tree, queues
// incoming notes, builds tree-update SNARKs, and submits the on-chain
// `transact` tx. Wallets POST their transact_2x2 proof + cms + ciphertexts
// here and never touch the chain themselves.
//
// The relayer can censor (refuse to submit, withhold ciphertext) but cannot
// forge: every merkle path it serves must verify against an on-chain
// `isKnownRoot` before the wallet trusts it for spending.

import type { Field, Point } from "./crypto/index";

export interface SubmitTransactPayload {
    /// Snarkjs-shaped Groth16 proof for the transact_2x2 circuit.
    proof2x2: {
        pi_a: string[];
        pi_b: string[][];
        pi_c: string[];
        protocol?: string;
        curve?: string;
    };
    /// Public signals as snarkjs emits them. For compressed-PI mode, this
    /// is the [y, z] pair the verifier consumes — same shape today.
    publicSignals: string[];
    /// The 22 logical PIs in declaration order — the relayer needs these
    /// (specifically cm0, cm1, payer, relayer, recipient, amounts, etc.)
    /// to build the matching tree-update proof + the transact() calldata.
    pubInputs: TransactPubInputs;
    /// Off-circuit FMD + ciphertext payload, one per output slot.
    aux: [TransactAux, TransactAux];
}

export interface TransactPubInputs {
    merkleRoot: Field;
    nullifier: [Field, Field];
    outCm: [Field, Field];
    publicAssetId: bigint;
    pubAssetGen: Point;
    publicIn: bigint;
    publicOut: bigint;
    inCv: [Point, Point];
    outCv: [Point, Point];
    recipient: string;     // 0x-hex address
    chainId: bigint;
    payer: string;         // 0x-hex address
    relayer: string;       // 0x-hex address; must equal the relayer's own
}

export interface TransactAux {
    /// Baby-Jubjub R = [r]·G — FMD clue group element.
    clueR: Point;
    /// Baby-Jubjub E = [e]·G — ECDH ephemeral pub.
    ephPub: Point;
    /// 2-byte big-endian clueBits prefix || ChaCha20-Poly1305 body.
    /// Off-chain only; never enters the contract.
    ciphertext: Uint8Array;
}

export interface RelayerSubmitResponse {
    /// Tx hash once mined. Relayer awaits inclusion before responding.
    txHash: string;
    /// Leaf indices of the two output cms, post-batch.
    leafIndex: [number, number];
}

export interface MerkleProofResponse {
    leafIndex: number;
    pathElements: Field[][];
    pathIndices: number[];
    /// Root computed from the path. Caller MUST `isKnownRoot[root]` against
    /// the chain before trusting the proof for spending.
    root: Field;
}

export interface TreeStateResponse {
    leafCount: number;
    root: Field;
    frontier: Field[][];
}

export interface ScannedNote {
    /// Encrypted note (ChaCha20-Poly1305 body + clueBits prefix).
    ciphertext: Uint8Array;
    clueR: Point;
    ephPub: Point;
    cm: Field;
    leafIndex: number;
}

/// Thin HTTP client. Implementations are server-defined; the wire format
/// here is the SDK's expectation — every relayer service speaking it MUST
/// match these shapes.
export class RelayerClient {
    constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

    async submitTransact(payload: SubmitTransactPayload): Promise<RelayerSubmitResponse> {
        return this.postJson("/transact", serializeSubmit(payload));
    }

    async scan(fmdSecret: string): Promise<ScannedNote[]> {
        const data = await this.getJson<{ notes: SerializedScannedNote[] }>(
            `/scan?fmdSecret=${encodeURIComponent(fmdSecret)}`,
        );
        return data.notes.map(deserializeScannedNote);
    }

    async path(cm: Field): Promise<MerkleProofResponse> {
        const data = await this.getJson<SerializedMerkleProof>(`/path?cm=${cm.toString()}`);
        return {
            leafIndex: data.leafIndex,
            pathElements: data.pathElements.map(lvl => lvl.map(BigInt)),
            pathIndices: data.pathIndices,
            root: BigInt(data.root),
        };
    }

    async treeState(): Promise<TreeStateResponse> {
        const data = await this.getJson<SerializedTreeState>("/tree-state");
        return {
            leafCount: data.leafCount,
            root: BigInt(data.root),
            frontier: data.frontier.map(lvl => lvl.map(BigInt)),
        };
    }

    private async getJson<T>(pathSuffix: string): Promise<T> {
        const r = await this.fetchImpl(this.baseUrl + pathSuffix);
        if (!r.ok) throw new Error(`relayer GET ${pathSuffix} failed: ${r.status}`);
        return r.json() as Promise<T>;
    }

    private async postJson<T>(pathSuffix: string, body: unknown): Promise<T> {
        const r = await this.fetchImpl(this.baseUrl + pathSuffix, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`relayer POST ${pathSuffix} failed: ${r.status}`);
        return r.json() as Promise<T>;
    }
}

interface SerializedScannedNote {
    ciphertext: string;       // hex
    clueR: [string, string];
    ephPub: [string, string];
    cm: string;
    leafIndex: number;
}

interface SerializedMerkleProof {
    leafIndex: number;
    pathElements: string[][];
    pathIndices: number[];
    root: string;
}

interface SerializedTreeState {
    leafCount: number;
    root: string;
    frontier: string[][];
}

function serializeSubmit(p: SubmitTransactPayload): unknown {
    return {
        proof2x2: p.proof2x2,
        publicSignals: p.publicSignals,
        pubInputs: serializePubInputs(p.pubInputs),
        aux: p.aux.map(serializeAux),
    };
}

function serializePubInputs(pi: TransactPubInputs): unknown {
    return {
        merkleRoot: pi.merkleRoot.toString(),
        nullifier: pi.nullifier.map(n => n.toString()),
        outCm: pi.outCm.map(c => c.toString()),
        publicAssetId: pi.publicAssetId.toString(),
        pubAssetGen: [pi.pubAssetGen[0].toString(), pi.pubAssetGen[1].toString()],
        publicIn: pi.publicIn.toString(),
        publicOut: pi.publicOut.toString(),
        inCv: pi.inCv.map(p => [p[0].toString(), p[1].toString()]),
        outCv: pi.outCv.map(p => [p[0].toString(), p[1].toString()]),
        recipient: pi.recipient,
        chainId: pi.chainId.toString(),
        payer: pi.payer,
        relayer: pi.relayer,
    };
}

function serializeAux(a: TransactAux): unknown {
    return {
        clueR: [a.clueR[0].toString(), a.clueR[1].toString()],
        ephPub: [a.ephPub[0].toString(), a.ephPub[1].toString()],
        ciphertext: bytesToHex(a.ciphertext),
    };
}

function deserializeScannedNote(s: SerializedScannedNote): ScannedNote {
    return {
        ciphertext: hexToBytes(s.ciphertext),
        clueR: [BigInt(s.clueR[0]), BigInt(s.clueR[1])] as Point,
        ephPub: [BigInt(s.ephPub[0]), BigInt(s.ephPub[1])] as Point,
        cm: BigInt(s.cm),
        leafIndex: s.leafIndex,
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
