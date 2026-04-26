// On-chain protocol structs for the deposit path.
//
// These mirror `PubInputs.sol` field-for-field. They live in `protocol/`
// because the chain adapter, the relayer codec, and the aux digest all consume
// them; none of those should depend on the Permit2 signer.

/**
 * Canonical Uniswap Permit2 deployment (deterministic CREATE2).
 *
 * @internal
 */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** `PubInputs.DepositIntent` mirror — wire-side bigints/hex. */
export interface DepositIntent {
    chainId: bigint;
    publicAssetId: bigint;
    publicIn: bigint;
    payer: string; // 0x address
    recipient: string; // 0x address
    /** Two output commitments. 0x-hex 32 B each. */
    outCm: [string, string];
    /**
     * Per-output Pedersen value commitment cv_dep_j = value_j · V^asset
     * + rcv_dep_j · H. Anchors (asset_id, value) into the Merkle leaf via
     * leaf_j = Poseidon(TAG_LEAF, cm_j, cv_dep_j_x, cv_dep_j_y).
     */
    cvDep0: [bigint, bigint];
    cvDep1: [bigint, bigint];
    /**
     * Sum rcv_dep_0 + rcv_dep_1. Published in the IntentEscrowed event so
     * the relayer can build the tree_update_batch witness without learning
     * recipient pk/rho/rcm. Pedersen blinder is information-theoretically
     * independent of value/asset/identity, so leaks nothing useful.
     */
    rcvTotal: bigint;
    /**
     * rcv_dep of the pad leaf (slot 1) alone. Lets tree_update_batch prove
     * cv_dep1 == rcvDepPad·H, i.e. the pad leaf commits to value 0, which
     * pins cv_dep0 to exactly `publicIn` units. The sum alone fixes only
     * Σvalue mod the subgroup order — a depositor could otherwise load leaf 0
     * with an out-of-range value and abandon leaf 1. Same blinder-only
     * disclosure argument as rcvTotal.
     */
    rcvDepPad: bigint;
}

/**
 * Component list of `AuxValidation.Output`. Shared by the deposit witness hash
 * and by `auxDigest` (the transact aux binding) so the two encodings cannot
 * drift apart. MUST match the struct in PubInputs.sol field-for-field.
 *
 * @internal
 */
export const AUX_OUTPUT_COMPONENTS = [
    { name: "clueRx", type: "uint256" },
    { name: "clueRy", type: "uint256" },
    { name: "ephPubX", type: "uint256" },
    { name: "ephPubY", type: "uint256" },
    { name: "ciphertext", type: "bytes" },
] as const;

/**
 * `AuxValidation.Output` mirror.
 *
 * @internal
 */
export interface AuxOutput {
    clueRx: bigint;
    clueRy: bigint;
    ephPubX: bigint;
    ephPubY: bigint;
    /** Raw bytes (2B clueBits prefix || ChaCha20Poly1305 body). */
    ciphertext: Uint8Array;
}

/** @internal */
export interface Permit2Sig {
    nonce: bigint;
    deadline: bigint;
    /**
     * Caller's ceiling on `inAmt + fee`. Bound into the Permit2 sig as
     * `permitted.amount`; the contract requests at most this amount.
     */
    maxTotal: bigint;
    /** 65-byte (r||s||v) hex string. */
    signature: string;
}

/**
 * Mirror of `IAllowanceTransfer.PermitDetails`.
 *
 * @internal
 */
export interface PermitDetails {
    token: string;
    /** uint160 cap on the spender's pull, in token base units. */
    amount: bigint;
    /** uint48 unix-seconds expiry of the allowance window. */
    expiration: number;
    /**
     * uint48 incrementing per (owner, token, spender). Read via
     * `IAllowanceTransfer.allowance(owner, token, spender)`.
     */
    nonce: number;
}

/**
 * Mirror of `IAllowanceTransfer.PermitSingle`.
 *
 * @internal
 */
export interface PermitSingle {
    details: PermitDetails;
    /** MASP contract address. */
    spender: string;
    /**
     * Outer EIP-712 deadline for the `permit()` call itself (separate
     * from `details.expiration` which gates each future pull).
     */
    sigDeadline: bigint;
}
