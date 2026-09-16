// `@lelantos-org/sdk/watch`: the watch-only wallet. A separate entry so a viewer's module graph never
// reaches the prover, the relayer submitter or the coin selector. `ReadOnlyWalletApi` is at the root.

export type { ConnectWatchOptions } from "../wallet/connect/options.js";
export { connectWatch } from "../wallet/watch/connect.js";
