// Coin selection. The algorithms live one file down; this is the entry point
// every caller outside `wallet/selection/` imports.

export { DenominationCoinSelector } from "./denomination.js";
export { SfrtCoinSelector, selectNotes } from "./sfrt.js";
export { spendableMax } from "./spendable-max.js";
export {
    type CoinSelector,
    type ConsolidateFirst,
    DEFAULT_COOLDOWN_BLOCKS,
    type DirectSelection,
    type SelectionResult,
    type SelectOpts,
    type SpendableMax,
    type WithheldValue,
} from "./types.js";
