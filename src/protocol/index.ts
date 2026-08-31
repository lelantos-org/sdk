// Tier 3 — the wire contract.
//
// Types and hashes shared by everything that speaks to the chain or the
// relayer: the on-chain structs, the relayer request/response shapes, and
// the two keccak(abi.encode(...)) bindings over them.
//
// Nothing here does I/O. Types-only modules at this tier are what let the
// relayer client and its codec both depend on the contract instead of on
// each other.

export { auxDigest, computePiHash } from "./abi-hash.js";
export {
    AUX_OUTPUT_COMPONENTS,
    type AuxOutput,
    type DepositRequest,
    PERMIT2_ADDRESS,
    type Permit2Sig,
    type PermitBatch,
    type PermitDetails,
    type PermitSingle,
} from "./deposit-request.js";
export type {
    ChainInfo,
    ChainsResponse,
    ChainToken,
    EstimateResponse,
    FeeQuote,
    MerkleProofResponse,
    RelayerDepositResponse,
    RelayerSubmitResponse,
    ScannedNote,
    ShieldedFeeTerms,
    YieldStateInfo,
} from "./responses.js";
export type {
    SpendKind,
    SubmitDepositPayload,
    SubmitSwapPayload,
    SubmitTransactPayload,
    SwapBlob,
    TransactAux,
    TransactPubInputs,
} from "./transact.js";
