// `@lelantos-org/sdk/protocol`: protocol arithmetic and wire shapes.
//
// Fees, denominations, deposit pulls, unit conversion, swap sizing, circuit shapes, relayer wire
// types and ABI hashes, the bundle builders and Permit2 signing. No wallet state.

export {
    type BuiltBundle,
    type BundleCommon,
    buildAuxForReal,
    buildInputs,
    deriveOutputRho,
    finalize,
    type InputSlot,
    type InputSlots,
    type OutputRandomness,
    type OutputRecipient,
} from "../bundle/common.js";
export { type BuiltDeposit, buildDeposit, type DepositArgs } from "../bundle/deposit.js";
export {
    type FeeOutput,
    type FeeOutputArgs,
    type FeeOutputFromEstimateArgs,
    feeOutput,
    feeOutputFromEstimate,
} from "../bundle/fee.js";
export { buildSpend, type SpendArgs } from "../bundle/spend.js";
export {
    type SignPermit2AllowanceArgs,
    type SignPermit2AllowanceBatchArgs,
    signPermit2Allowance,
    signPermit2AllowanceBatch,
} from "../permit2/allowance.js";
export { type SignPermit2Args, signPermit2Witness } from "../permit2/witness.js";
export { auxDigest, computePiHash, swapIntentHash } from "../protocol/abi-hash.js";
export {
    type Decomposition,
    type DenominationPolicy,
    decompose,
    descendingAtMost,
    isDenomination,
    type Ladder,
    type LadderInputs,
    largestAtMost,
    nearest,
    resolveLadder,
    universalLadder,
} from "../protocol/denominations.js";
export {
    type DepositFeeAssetRefusal,
    type DepositPullAsset,
    type DepositPullEntry,
    type DepositPulls,
    type DepositPullsArgs,
    depositFeeAssetRefusal,
    depositPulls,
} from "../protocol/deposit-pulls.js";
export {
    AUX_OUTPUT_COMPONENTS,
    type AuxOutput,
    type DepositRequest,
    PERMIT2_ADDRESS,
    type Permit2Sig,
    type PermitBatch,
    type PermitDetails,
    type PermitSingle,
} from "../protocol/deposit-request.js";
export {
    applyFee,
    assertPublicInFits,
    BPS_DENOMINATOR,
    type DepositTotals,
    type DepositTotalsArgs,
    depositTotals,
    type FeeOverride,
    type FeeRates,
    type GrossForNetArgs,
    grossForNet,
    isSameFeeAsset,
    PUBLIC_IN_MAX,
    resolveFeeRates,
    unitFee,
    type WithdrawNet,
    type WithdrawNetArgs,
    withdrawNet,
} from "../protocol/fees.js";
export type {
    ChainInfo,
    ChainsResponse,
    ChainToken,
    EstimateResponse,
    RelayerFeeQuote,
    RelayerSubmitResponse,
    ShieldedFeeTerms,
    YieldStateInfo,
} from "../protocol/responses.js";
export {
    challengeWordCount,
    coeffCount,
    DEFAULT_SHAPE,
    shapeId,
    TRANSACT_4X6,
} from "../protocol/shape.js";
export { sizeBNote, sizeRefundNote, type YieldPricing } from "../protocol/swap-sizing.js";
export type {
    SpendKind,
    SubmitSwapPayload,
    SubmitTransactPayload,
    SwapBlob,
    TransactPubInputs,
} from "../protocol/transact.js";
export {
    formatUnits,
    parseUnits,
    RAY,
    toCircuitUnits,
    toTokenUnits,
    toTokenUnitsAtRate,
    type YieldRate,
} from "../protocol/units.js";
export { withdrawNetFor } from "../wallet/assets/amounts.js";
