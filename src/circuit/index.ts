// Tier 3 — the circuit contract.
//
// Witness construction and the public-input compression the on-chain
// verifier mirrors. Proving happens in `bundle/`.

export { fiatShamirZ, flatten } from "./compression.js";
export { circuitSignals, type TransactWitnessBundle, toCircomInput } from "./input.js";
export { dummyInputAt, type SpendableCachedNote, toSpentNoteFromPath } from "./spent-note.js";
