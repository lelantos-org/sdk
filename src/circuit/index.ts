// Tier 3 — the circuit contract.
//
// Witness construction and the public-input compression the on-chain
// verifier mirrors. Nothing here proves anything; `bundle/` does that.

export { coeffs, type FlattenInput, fiatShamirZ, flatten, hornerEval } from "./compression.js";
export {
    type BuildOpts,
    type CircomCoeffInputs,
    type CircomPublicInputs,
    type CircomTransactInput,
    circuitSignals,
    type TransactBinding,
    type TransactWitnessBundle,
    toCircomInput,
} from "./input.js";
export {
    type DummyBlinders,
    dummyInputAt,
    type SpendableCachedNote,
    toSpentNoteFromPath,
} from "./spent-note.js";
