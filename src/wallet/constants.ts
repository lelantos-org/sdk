// Wallet-layer constants.

/**
 * Upper bound on `treeDepth`. `4 ** 24` leaves exceeds any deployment and keeps `maxChunksFor`
 * within safe-integer range.
 */
export const MAX_TREE_DEPTH = 24;

/**
 * Default Permit2 signature lifetime, in seconds, when `wallet.deposit` is called without
 * `deadline`. Bounds how long a captured signature can be replayed.
 */
export const PERMIT2_DEFAULT_DEADLINE_SECS = 3600;

/**
 * Default swap lifetime, in seconds, from when the wallet builds the swap, when `wallet.swap` is
 * called without `deadline`. The deadline is bound into the withdraw proof's intent hash, so it
 * covers proving and relayer queueing as well as submission. Past it `SwapWrapper` refunds the
 * input instead of swapping, and the relayer refuses a swap within minutes of it.
 */
export const SWAP_DEFAULT_DEADLINE_SECS = 900;

/**
 * Default lifetime, in seconds, of a `GenericCallWrapper` intent built without `deadline`. Bound
 * into the withdraw proof's intent hash like a swap's; past it the wrapper refunds the input
 * instead of making the calls.
 */
export const GENERIC_DEFAULT_DEADLINE_SECS = 900;

/**
 * Gas the call leg `[approve, register]` of a handle registration is forwarded, for a shielded
 * address as the value. Equal to `REGISTER_MIN_GAS` in `contracts/test/names/NameFixtures.sol`,
 * which `NameRegistrationGas.t.sol` holds the measured leg under with a quarter to spare and an
 * allowance for a fee token dearer than a plain ERC-20. The relayer's fee for a registration is
 * quoted for it.
 */
export const REGISTER_NAME_MIN_GAS = 360_000n;

/**
 * A Permit2 AllowanceTransfer window expiring within this many seconds is not reused, so the
 * allowance does not lapse mid-transaction under block-clock skew or confirmation latency.
 */
export const ALLOWANCE_BUFFER_SECS = 60;

/** Default poll interval for `wallet.awaitCommitments`, in milliseconds. */
export const AWAIT_COMMITMENTS_DEFAULT_POLL_MS = 2_000;

/**
 * Default deadline for `wallet.awaitCommitments`, in milliseconds, after which it resolves
 * `{ status: "timeout" }` (or rejects with `throwOnTimeout`).
 */
export const AWAIT_COMMITMENTS_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * How long a note stays reserved after a spend with unknown outcome, in milliseconds. See
 * `StoredNote.pendingSpendAt`.
 *
 * Matches the relayer, which refuses an already-submitted nullifier for 15 minutes while waiting
 * for the indexer; a shorter reservation would release notes that are still refused. After it, a
 * spend that landed has been observed on-chain and the note is marked spent; one that did not
 * land is released and the balance returns without a rescan.
 */
export const SPEND_RESERVATION_MS = 15 * 60 * 1000;
