// Relayer wire contract: request payloads. Every relayer service speaking the protocol must match
// these shapes.

import type { Field } from "../crypto/index.js";
import type { OutputAux } from "../notes/aux.js";
import type { DepositRequest } from "./deposit-request.js";

/**
 * Spend op the relayer routes on-chain; maps 1:1 to the MASP entry point.
 *
 * Not `@internal`: `RelayerClient.estimateSpend` takes one, and `EstimateKind` is widened from it.
 */
export type SpendKind = "transfer" | "withdraw" | "withdrawNative";

/** @internal */
export interface SubmitTransactPayload {
    /** Target chain id; relayer routes to the per-chain pipeline by this key. */
    chainId: bigint;
    /** On-chain entry point the relayer should call. */
    kind: SpendKind;
    /** Snarkjs-shaped Groth16 proof for the transact circuit. */
    proof: {
        piA: string[];
        piB: string[][];
        piC: string[];
        protocol?: string;
        curve?: string;
    };
    /**
     * The `PubInputs.Transact` struct words. The relayer derives the three
     * clue words per output and the aux digest from `aux`, so those are
     * absent here: 19 struct words + 18 clue words + 1 at 4×6.
     */
    pubInputs: TransactPubInputs;
    /** Off-circuit FMD + ciphertext payload, one per output slot. */
    aux: OutputAux[];
}

/**
 * Atomic shielded-swap payload: the leg-1 transact SNARK (same shape as a `withdraw` whose
 * recipient is the SwapWrapper) plus the leg-2 escrow blob the wrapper forwards to
 * `submitDepositAuthorized` in the same tx. The relayer adds the matching tree_update_batch proof
 * and submits to `SwapWrapper.swap`.
 */
export interface SubmitSwapPayload {
    chainId: bigint;
    /** Same layout as `SubmitTransactPayload`; the relayer applies the same shape validators. */
    proof: SubmitTransactPayload["proof"];
    pubInputs: TransactPubInputs;
    aux: OutputAux[];
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
     * Slim deposit request for the B note. `payer` must equal the `swap_wrapper_address`
     * configured on the relayer.
     */
    depositD: DepositRequest;
    /**
     * FMD + ciphertext for the B-side output. Matches the on-chain
     * `AuxValidation.Output` struct, which the deposit path takes singly.
     */
    auxD: OutputAux;
    /**
     * FMD + ciphertext for the B-side deposit's fee leaf. Every deposit mints two leaves, and
     * both need an aux payload. The swap pays the relayer on its withdraw leg, so this one
     * carries a zero-value note, but it is still a leaf and part of the escrow digest preimage.
     */
    feeAuxD: OutputAux;
    /**
     * Slim deposit request for the refund note: the A note, in `tokenIn` and addressed to the
     * spender, that the wrapper escrows the unshield back into when the venue leg fails (a venue
     * revert, output below `minOut`, a passed deadline). `payer` is the wrapper, as for `depositD`.
     */
    refundD: DepositRequest;
    /** FMD + ciphertext for the refund note, as `auxD` is for the B note. */
    refundAuxD: OutputAux;
    /** FMD + ciphertext for the refund deposit's fee leaf, as `feeAuxD`. */
    refundFeeAuxD: OutputAux;
    /** 0x-hex ERC20 addresses. */
    tokenIn: string;
    tokenOut: string;
    /** Token base-units (`pi.publicOut * scale`). Wrapper re-asserts. */
    amountIn: bigint;
    /** Slippage floor on the venue's output. Wrapper enforces `actualOut >= minOut`. */
    minOut: bigint;
    /**
     * Hard expiry, unix seconds. When `block.timestamp > deadline` the wrapper
     * refunds into `refundD` instead of swapping. Always set: it is part of the
     * intent hash the withdraw proof binds, so the relayer must submit exactly
     * this value.
     */
    deadline: bigint;
    /**
     * 0x-hex address a cancelled output escrow refunds to (`SwapArgs.refundTo`). Never zero and
     * never the wrapper.
     */
    refundTo: string;
}

/**
 * `PubInputs.Transact` mirror, in struct order.
 *
 * @internal
 */
export interface TransactPubInputs {
    merkleRoot: Field;
    /** One per input slot: `nIn` entries. */
    nullifier: Field[];
    /** One per output slot: `nOut` entries. Each is the tree leaf. */
    outCm: Field[];
    /** Zero unless `publicOut != 0`; the pool reverts `MustNotNameAsset` otherwise. */
    publicAssetId: bigint;
    publicOut: bigint;
    /**
     * The circuit's digest public signal: the Poseidon commitment to the
     * coefficients above. The pool hashes it into the challenge and hands it
     * to the verifier unmodified, so any other value fails the proof.
     */
    digest: Field;
    recipient: string; // 0x-hex address
    chainId: bigint;
    payer: string; // 0x-hex address
    relayer: string; // 0x-hex address; must equal the relayer's own
    /**
     * Field element. What the spend's funds are used for: `swapIntentHash`
     * of the swap's output, floor, venue, deadline and refund owner, checked
     * only by `SwapWrapper.swap`. Zero for every non-swap spend.
     */
    intentHash: Field;
}
