// Wallet-layer constants.

/**
 * Upper bound on `treeDepth`. `4 ** 24` leaves exceeds any deployment and keeps `maxChunksFor`
 * within safe-integer range.
 */
export const MAX_TREE_DEPTH = 24;

/**
 * Default Permit2 signature lifetime, in seconds, when `wallet.deposit` is
 * called without `deadline`. Long enough for a slow signing flow, short enough
 * to limit replay of a captured signature.
 */
export const PERMIT2_DEFAULT_DEADLINE_SECS = 3600;

/**
 * Default swap lifetime, in seconds, from when the wallet builds the swap, when
 * `wallet.swap` is called without `deadline`. The deadline is bound into the
 * withdraw proof's intent hash, so it covers proving and relayer queueing as
 * well as submission. Past it `SwapWrapper` refunds the input instead of
 * swapping, and the relayer refuses a swap within minutes of it.
 */
export const SWAP_DEFAULT_DEADLINE_SECS = 900;

/**
 * A Permit2 AllowanceTransfer window expiring within this many seconds is not
 * reused, leaving headroom for block-clock skew and confirmation latency so the
 * allowance does not lapse mid-transaction.
 */
export const ALLOWANCE_BUFFER_SECS = 60;

/**
 * Default poll interval for `wallet.awaitCommitments`, in milliseconds.
 * Balances FMD-server load against user-perceived latency.
 */
export const AWAIT_COMMITMENTS_DEFAULT_POLL_MS = 2_000;

/**
 * Default deadline for `wallet.awaitCommitments`, in milliseconds, after which it resolves
 * `{ status: "timeout" }` (or rejects with `throwOnTimeout`).
 */
export const AWAIT_COMMITMENTS_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * How long a note stays reserved after a spend with unknown outcome, in
 * milliseconds. See `StoredNote.pendingSpendAt`.
 *
 * Matches the relayer, which refuses an already-submitted nullifier for 15
 * minutes while waiting for the indexer; a shorter reservation would release
 * notes that are still refused. After it, a spend that landed has been observed
 * on-chain and the note is marked spent; one that did not land is released and
 * the balance returns without a rescan.
 */
export const SPEND_RESERVATION_MS = 15 * 60 * 1000;
