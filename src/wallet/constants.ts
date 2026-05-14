// Wallet-layer constants. Centralised so call sites import named values
// rather than embedding magic numbers.

/// Default Permit2 signature lifetime, in seconds. Applied when the
/// caller does not pass an explicit `deadline` to `wallet.deposit`.
/// Long enough to absorb a slow signing-UX flow, short enough that a
/// captured signature can't be replayed weeks later.
export const PERMIT2_DEFAULT_DEADLINE_SECS = 3600;

/// Refuse to reuse a Permit2 AllowanceTransfer window that expires
/// within this many seconds. Buys headroom against block-clock skew /
/// confirmation latency so the allowance doesn't lapse mid-tx.
export const ALLOWANCE_BUFFER_SECS = 60;

/// Default poll interval for `wallet.awaitCommitments`, in milliseconds.
/// Balances FMD-server load against user-perceived latency.
export const AWAIT_COMMITMENTS_DEFAULT_POLL_MS = 1500;

/// Default attempt cap for `wallet.awaitCommitments`. With the default
/// poll interval this gives ~45 s of patience before the call resolves
/// without seeing every commitment.
export const AWAIT_COMMITMENTS_DEFAULT_MAX_ATTEMPTS = 30;

/// Page size for the periodic `sync({ limit })` calls inside
/// `awaitCommitments`. Small enough to keep each iteration cheap.
export const AWAIT_COMMITMENTS_SYNC_LIMIT = 200;

/// Basis-points denominator. `feeBps` is a uint16 fraction of 10_000;
/// `fee = amount * feeBps / BPS_DENOMINATOR` mirrors `MASP._takeFee`
/// on-chain. Same constant used across deposit/withdraw/swap so a future
/// switch to ppm only changes one place.
export const BPS_DENOMINATOR = 10_000n;
