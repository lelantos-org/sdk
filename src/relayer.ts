// Wallet-side HTTP client for the off-chain MASP relayer service.
//
// New-flow split:
//   - Deposits: wallet escrows funds via `MASP.submitIntent` (Permit2 witness
//     bound to DepositIntent + aux). Wallet POSTs `SubmitIntentPayload` to
//     `/v1/intent`; relayer broadcasts the on-chain submitIntent and later
//     batches up to MAX_N=8 escrowed intents under one `flushBatch` SNARK.
//   - Spends (transfer / withdraw / withdrawNative): wallet builds the
//     transact_2x2 SNARK + transact pubInputs + per-output AuxValidation
//     payload. Wallet POSTs `SubmitTransactPayload` to `/v1/transact`;
//     relayer assembles the matching tree_update_batch SNARK (it owns the
//     249 MB zkey and the tree state) and submits the on-chain spend.
//
// The relayer can censor (refuse to submit, withhold ciphertext) but cannot
// forge: every merkle path it serves must verify against an on-chain
// `isKnownRoot` before the wallet trusts it for spending.

import type { Field, Point } from "./crypto/index.js";
import type { AuxOutput, DepositIntent, Permit2Sig } from "./permit2.js";
import {
    deserializeMerkleProof,
    deserializeScannedNote,
    deserializeTreeState,
    type SerializedMerkleProof,
    type SerializedScannedNote,
    type SerializedTreeState,
    serializeSubmitIntent,
    serializeSubmitSwap,
    serializeSubmitTransact,
} from "./relayer-codec.js";
import { createHttpClient, type HttpClient, type HttpClientOptions } from "./wallet/http.js";

/// Spend op the relayer should route to on-chain. Maps 1:1 to the MASP
/// entry point: `transfer` / `withdraw` / `withdrawNative`. The relayer
/// attaches the matching `tree_update_batch` proof + tpi from its own
/// state; wallet never proves that circuit.
export type SpendKind = "transfer" | "withdraw" | "withdrawNative";

export interface SubmitTransactPayload {
    /// Target chain id; relayer routes to the per-chain pipeline by this key.
    chainId: bigint;
    /// On-chain entry point the relayer should call.
    kind: SpendKind;
    /// Snarkjs-shaped Groth16 proof for the transact_2x2 circuit.
    proof2x2: {
        piA: string[];
        piB: string[][];
        piC: string[];
        protocol?: string;
        curve?: string;
    };
    /// The 20 base logical PIs (6 clue PIs are derived by the relayer from `aux`).
    pubInputs: TransactPubInputs;
    /// Off-circuit FMD + ciphertext payload, one per output slot.
    aux: [TransactAux, TransactAux];
}

/// Deposit-side payload: wallet pre-built DepositIntent + Permit2 signature
/// + per-output FMD/ciphertext. Relayer broadcasts `MASP.submitIntent`.
export interface SubmitIntentPayload {
    chainId: bigint;
    intent: DepositIntent;
    permit2: Permit2Sig;
    aux: [AuxOutput, AuxOutput];
}

/// Atomic shielded-swap payload. Carries the leg-1 transact_2x2 SNARK
/// (same shape as a `withdraw` whose recipient is the SwapWrapper) plus
/// the leg-2 escrow blob the wrapper forwards to `submitIntentAuthorized`
/// in the same tx. Relayer adds the matching tree_update_batch proof and
/// submits to `SwapWrapper.swap`.
export interface SubmitSwapPayload {
    chainId: bigint;
    /// Identical layout to `SubmitTransactPayload` — the relayer reuses
    /// the same shape validators on the leg-1 SNARK.
    proof2x2: SubmitTransactPayload["proof2x2"];
    pubInputs: TransactPubInputs;
    aux: [TransactAux, TransactAux];
    swap: SwapBlob;
}

/// Leg-2 escrow + venue routing.
export interface SwapBlob {
    /// Allowlisted `ISwapAdapter` deployed alongside the wrapper.
    adapter: string;
    /// Adapter-specific encoded calldata (UniV3: `abi.encode(uint24 fee)`
    /// or path bytes). 0x-hex.
    route: string;
    /// Slim deposit intent for the B note. `payer` MUST equal the
    /// `swap_wrapper_address` configured on the relayer.
    intentD: DepositIntent;
    /// FMD + ciphertext for the B-side outputs. Same shape as the leg-1
    /// `aux` (matches the on-chain `OutputAux` struct).
    auxD: [TransactAux, TransactAux];
    /// 0x-hex ERC20 addresses.
    tokenIn: string;
    tokenOut: string;
    /// Token base-units (`pi.publicOut * scale`). Wrapper re-asserts.
    amountIn: bigint;
    /// Slippage floor on the venue's output. Wrapper enforces
    /// `actualOut >= minOut`.
    minOut: bigint;
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
    /// Per-output Pedersen value commitment that anchors (asset, value) into
    /// the Merkle leaf. Forwarded into the spend's tree_update_batch tpi.
    outCvDep: [Point, Point];
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

export interface RelayerIntentResponse {
    txHash: string;
    /// Intent id allocated by `MASP.submitIntent` (== `nextIntentId` at
    /// time of the call). Wallet uses this to track escrow lifecycle and
    /// for `MASP.cancelIntent` if the relayer never flushes.
    intentId: bigint;
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
        return this.postJson("/v1/spend", serializeSubmitTransact(payload));
    }

    async submitSwap(payload: SubmitSwapPayload): Promise<RelayerSubmitResponse> {
        return this.postJson("/v1/swap", serializeSubmitSwap(payload));
    }

    async submitIntent(payload: SubmitIntentPayload): Promise<RelayerIntentResponse> {
        const r = await this.postJson<{ txHash: string; intentId: string | number }>(
            "/v1/intent",
            serializeSubmitIntent(payload),
        );
        return { txHash: r.txHash, intentId: BigInt(r.intentId) };
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
