// Bundle building: turn notes plus a proof into a relayer payload.
//
// `buildSpend` covers transfer / withdraw / withdrawNative (they differ by
// `kind` and `publicOut`). `buildDeposit` does NOT prove — deposits go
// through `MASP.deposit` with a Permit2 witness.

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
} from "./common.js";
export { type BuiltDeposit, buildDeposit, type DepositArgs } from "./deposit.js";
export {
    type FeeOutput,
    type FeeOutputArgs,
    type FeeOutputFromEstimateArgs,
    feeOutput,
    feeOutputFromEstimate,
} from "./fee.js";
export { buildSpend, type SpendArgs } from "./spend.js";
