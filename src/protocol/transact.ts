// Relayer wire contract: request payloads.
//
// These types are the SDK's expectation of the protocol — every relayer
// service speaking it MUST match these shapes. They live in `protocol/`
// rather than beside the HTTP client so the client and the codec can both
// depend on them without depending on each other.

import type { Field, Point } from "../crypto/index.js";
import type { OutputAux } from "../notes/aux.js";
import type { AuxOutput, DepositRequest, Permit2Sig } from "./deposit-request.js";

/**
 * Spend op the relayer routes on-chain; maps 1:1 to the MASP entry point.
 *
 * @internal
 */
export type SpendKind = "transfer" | "withdraw" | "withdrawNative";

/** @internal */
export interface SubmitTransactPayload {
    /** Target chain id; relayer routes to the per-chain pipeline by this key. */
    chainId: bigint;
    /** On-chain entry point the relayer should call. */
    kind: SpendKind;
    /**
     * Snarkjs-shaped Groth16 proof for the transact circuit.
     *
     * The field name pins the 2×2 shape and is the relayer's contract, not
     * this SDK's — a wider circuit needs the name changed on both sides at
     * once, so it stays as-is until that is coordinated. The arities above
     * are already shape-generic.
     */
    proof: {
        piA: string[];
        piB: string[][];
        piC: string[];
        protocol?: string;
        curve?: string;
    };
    /**
     * The base logical PIs. The relayer derives the three clue slots per
     * output from `aux`, so those are absent here: 20 base + 6 derived at
     * 2×2, 27 + 9 at 3×3.
     */
    pubInputs: TransactPubInputs;
    /** Off-circuit FMD + ciphertext payload, one per output slot. */
    aux: TransactAux[];
}

/**
 * Deposit-side payload: wallet pre-built DepositRequest + Permit2 signature
 * + per-output FMD/ciphertext. Relayer broadcasts `MASP.deposit`.
 *
 * @internal
 */
export interface SubmitDepositPayload {
    chainId: bigint;
    deposit: DepositRequest;
    permit2: Permit2Sig;
    /**
     * The depositor's note payload.
     *
     * A deposit mints two leaves — this one and the note paying whoever
     * flushes it — so `MASP.deposit` takes an `aux` for each. That is
     * independent of the transact circuit's shape; the batch circuit binds
     * each leaf on its own.
     */
    aux: AuxOutput;
    /** The relayer's fee note payload. */
    feeAux: AuxOutput;
}

/**
 * Atomic shielded-swap payload. Carries the leg-1 transact_2x2 SNARK
 * (same shape as a `withdraw` whose recipient is the SwapWrapper) plus
 * the leg-2 escrow blob the wrapper forwards to `submitDepositAuthorized`
 * in the same tx. Relayer adds the matching tree_update_batch proof and
 * submits to `SwapWrapper.swap`.
 */
export interface SubmitSwapPayload {
    chainId: bigint;
    /**
     * Identical layout to `SubmitTransactPayload` — the relayer reuses
     * the same shape validators on the leg-1 SNARK.
     */
    proof: SubmitTransactPayload["proof"];
    pubInputs: TransactPubInputs;
    aux: TransactAux[];
    swap: SwapBlob;
}

/**
 * Leg-2 escrow + venue routing.
 *
 * @internal
 */
export interface SwapBlob {
    /** Allowlisted `ISwapAdapter` deployed alongside the wrapper. */
    adapter: string;
    /**
     * Adapter-specific encoded calldata. UniV3 single-hop is
     * `abi.encode(uint24 fee, uint160 sqrtPriceLimitX96)` (64B); multi-hop
     * uses `abi.encodePacked` path bytes. 0x-hex.
     */
    route: string;
    /**
     * Slim deposit request for the B note. `payer` MUST equal the
     * `swap_wrapper_address` configured on the relayer.
     */
    depositD: DepositRequest;
    /**
     * FMD + ciphertext for the B-side output. Matches the on-chain
     * `AuxValidation.Output` struct, which the deposit path takes singly.
     */
    auxD: TransactAux;
    /**
     * FMD + ciphertext for the B-side deposit's fee leaf. Every deposit mints
     * two leaves, and both need an aux payload. The swap already pays the
     * relayer on its withdraw leg, so this one carries a zero-value note —
     * but it is still a real leaf and still escrow digest preimage.
     */
    feeAuxD: TransactAux;
    /** 0x-hex ERC20 addresses. */
    tokenIn: string;
    tokenOut: string;
    /** Token base-units (`pi.publicOut * scale`). Wrapper re-asserts. */
    amountIn: bigint;
    /**
     * Slippage floor on the venue's output. Wrapper enforces
     * `actualOut >= minOut`.
     */
    minOut: bigint;
    /**
     * Hard expiry, unix seconds. Wrapper reverts `SwapExpired` once
     * `block.timestamp > deadline`. Optional on the wire — relayer
     * defaults if absent.
     */
    deadline?: bigint;
}

/** @internal */
export interface TransactPubInputs {
    merkleRoot: Field;
    /** One per input slot: `nIn` entries. */
    nullifier: Field[];
    /** One per output slot: `nOut` entries. */
    outCm: Field[];
    publicAssetId: bigint;
    publicIn: bigint;
    publicOut: bigint;
    inCv: Point[];
    outCv: Point[];
    recipient: string; // 0x-hex address
    chainId: bigint;
    payer: string; // 0x-hex address
    relayer: string; // 0x-hex address; must equal the relayer's own
    /**
     * Per-output Pedersen value commitment that anchors (asset, value) into
     * the Merkle leaf. Forwarded into the spend's tree_update_batch tpi.
     */
    outCvDep: Point[];
}

/**
 * Wire alias for the builder-side `OutputAux` (`{clueR, ephPub, ciphertext}`).
 *
 * @internal
 */
export type TransactAux = OutputAux;
