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

import type { Field, Point } from "./crypto/index.js";
import type { Erc2612Permit } from "./permit.js";
import { createHttpClient, type HttpClient, type HttpClientOptions } from "./wallet/http.js";

export interface SubmitTransactPayload {
    /// Target chain id; relayer routes to the per-chain pipeline by this key.
    chainId: bigint;
    /// Snarkjs-shaped Groth16 proof for the transact_2x2 circuit.
    proof2x2: {
        piA: string[];
        piB: string[][];
        piC: string[];
        protocol?: string;
        curve?: string;
    };
    /// The 22 logical PIs in declaration order — the relayer needs these
    /// (specifically cm0, cm1, payer, relayer, recipient, amounts, etc.)
    /// to build the matching tree-update proof + the transact() calldata.
    pubInputs: TransactPubInputs;
    /// Off-circuit FMD + ciphertext payload, one per output slot.
    aux: [TransactAux, TransactAux];
    /// Optional EIP-2612 permit. Present → relayer routes to
    /// `MASP.transactWithPermit`, lifting the deposit allowance atomically.
    /// Absent → relayer falls back to legacy `MASP.transact` (caller must
    /// have approved beforehand).
    permit?: Erc2612Permit;
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
    recipient: string; // 0x-hex address
    chainId: bigint;
    payer: string; // 0x-hex address
    relayer: string; // 0x-hex address; must equal the relayer's own
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
    private readonly http: HttpClient;

    constructor(
        private readonly baseUrl: string,
        opts?: HttpClientOptions | typeof fetch,
    ) {
        // Back-compat: second arg used to be a raw `fetch` impl.
        const httpOpts: HttpClientOptions =
            typeof opts === "function" ? { fetchImpl: opts } : (opts ?? {});
        this.http = createHttpClient("RELAYER_TIMEOUT", "RELAYER_FAILED", httpOpts);
    }

    async submitTransact(payload: SubmitTransactPayload): Promise<RelayerSubmitResponse> {
        return this.postJson("/v1/transact", serializeSubmit(payload));
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
            pathElements: data.pathElements.map((lvl) => lvl.map(BigInt)),
            pathIndices: data.pathIndices,
            root: BigInt(data.root),
        };
    }

    async treeState(): Promise<TreeStateResponse> {
        const data = await this.getJson<SerializedTreeState>("/tree-state");
        return {
            leafCount: data.leafCount,
            root: BigInt(data.root),
            frontier: data.frontier.map((lvl) => lvl.map(BigInt)),
        };
    }

    private async getJson<T>(pathSuffix: string): Promise<T> {
        const r = await this.http.fetch(this.baseUrl + pathSuffix);
        return r.json() as Promise<T>;
    }

    private async postJson<T>(pathSuffix: string, body: unknown): Promise<T> {
        const r = await this.http.fetch(this.baseUrl + pathSuffix, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        return r.json() as Promise<T>;
    }
}

interface SerializedScannedNote {
    ciphertext: string; // hex
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
    return out;
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
