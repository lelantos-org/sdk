// Relayer wire contract: request payloads.
//
// These types are the SDK's expectation of the protocol — every relayer
// service speaking it MUST match these shapes. They live in `protocol/`
// rather than beside the HTTP client so the client and the codec can both
// depend on them without depending on each other.

import type { Field, Point } from "../crypto/index.js";
import type { OutputAux } from "../notes/aux.js";
import type { AuxOutput, DepositIntent, Permit2Sig } from "./deposit-intent.js";

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
    /** Snarkjs-shaped Groth16 proof for the transact_2x2 circuit. */
    proof2x2: {
        piA: string[];
        piB: string[][];
        piC: string[];
        protocol?: string;
        curve?: string;
    };
    /** The 20 base logical PIs (6 clue PIs are derived by the relayer from `aux`). */
    pubInputs: TransactPubInputs;
    /** Off-circuit FMD + ciphertext payload, one per output slot. */
    aux: [TransactAux, TransactAux];
}

/**
 * Deposit-side payload: wallet pre-built DepositIntent + Permit2 signature
 * + per-output FMD/ciphertext. Relayer broadcasts `MASP.submitIntent`.
 *
 * @internal
 */
export interface SubmitIntentPayload {
    chainId: bigint;
    intent: DepositIntent;
    permit2: Permit2Sig;
    aux: [AuxOutput, AuxOutput];
}

/**
 * Atomic shielded-swap payload. Carries the leg-1 transact_2x2 SNARK
 * (same shape as a `withdraw` whose recipient is the SwapWrapper) plus
 * the leg-2 escrow blob the wrapper forwards to `submitIntentAuthorized`
 * in the same tx. Relayer adds the matching tree_update_batch proof and
 * submits to `SwapWrapper.swap`.
 */
export interface SubmitSwapPayload {
    chainId: bigint;
    /**
     * Identical layout to `SubmitTransactPayload` — the relayer reuses
     * the same shape validators on the leg-1 SNARK.
     */
    proof2x2: SubmitTransactPayload["proof2x2"];
    pubInputs: TransactPubInputs;
    aux: [TransactAux, TransactAux];
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
     * Slim deposit intent for the B note. `payer` MUST equal the
     * `swap_wrapper_address` configured on the relayer.
     */
    intentD: DepositIntent;
    /**
     * FMD + ciphertext for the B-side outputs. Same shape as the leg-1
     * `aux` (matches the on-chain `OutputAux` struct).
     */
    auxD: [TransactAux, TransactAux];
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
    /**
     * Per-output Pedersen value commitment that anchors (asset, value) into
     * the Merkle leaf. Forwarded into the spend's tree_update_batch tpi.
     */
    outCvDep: [Point, Point];
}

/**
 * Wire alias for the builder-side `OutputAux` (`{clueR, ephPub, ciphertext}`).
 *
 * @internal
 */
export type TransactAux = OutputAux;
