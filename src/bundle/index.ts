// Bundle building: turn notes plus a proof into a relayer payload.
//
// `buildSpend` covers transfer / withdraw / withdrawNative (they differ by
// `kind` and `publicOut`). `buildDeposit` does NOT prove — deposits go
// through `MASP.submitIntent` with a Permit2 witness.

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
export { type BuiltIntent, buildDeposit, type DepositArgs } from "./deposit.js";
export { buildSpend, type SpendArgs } from "./spend.js";
