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
    type DepositIntent,
    PERMIT2_ADDRESS,
    type Permit2Sig,
    type PermitDetails,
    type PermitSingle,
} from "./deposit-intent.js";
export type {
    MerkleProofResponse,
    RelayerIntentResponse,
    RelayerSubmitResponse,
    ScannedNote,
    TreeStateResponse,
} from "./responses.js";
export type {
    SpendKind,
    SubmitIntentPayload,
    SubmitSwapPayload,
    SubmitTransactPayload,
    SwapBlob,
    TransactAux,
    TransactPubInputs,
} from "./transact.js";
