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
import {
    deserializeMerkleProof,
    deserializeScannedNote,
    deserializeTreeState,
    type SerializedMerkleProof,
    type SerializedScannedNote,
    type SerializedTreeState,
    serializeSubmit,
} from "./relayer-codec.js";
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
    /// Optional WETH bridge directive. `"withdrawEth"` instructs the
    /// submitter to call `MASP.withdrawEth` (the contract unwraps WETH and
    /// forwards raw ETH to `pi.recipient`). Absent → standard `transact` /
    /// `transactWithPermit` path. Deposit-side bridging was removed; users
    /// wrap ETH→WETH off-pool before depositing.
    bridge?: "withdrawEth";
}

export interface TransactPubInputs {
    merkleRoot: Field;
    nullifier: [Field, Field];
    outCm: [Field, Field];
    publicAssetId: bigint;
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
        return deserializeMerkleProof(
            await this.getJson<SerializedMerkleProof>(`/path?cm=${cm.toString()}`),
        );
    }

    async treeState(): Promise<TreeStateResponse> {
        return deserializeTreeState(await this.getJson<SerializedTreeState>("/tree-state"));
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

