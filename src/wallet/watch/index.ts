// Watch-only wallet: read a shielded account from a viewing key.
//
// A separate entry point, so this module graph never reaches the prover, the
// relayer submitter or the coin selector. See `./watch-wallet.ts`.

// `resolveWatchConfig` and `validateWatchConfig` stay unexported: both are
// internals of `WatchWallet.create`. `ResolvedWatchConfig` is forwarded because
// `WatchWallet.cfg` is typed by it.
export type { ResolvedWatchConfig, WatchWalletConfig } from "./config.js";
export { type ConnectWatchOptions, connectWatch } from "./connect.js";
export { WatchWallet } from "./watch-wallet.js";
