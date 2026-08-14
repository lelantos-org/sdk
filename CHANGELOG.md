# Changelog

Pre-1.0: minor releases may contain breaking API changes. See
[README.md](./README.md#stability).

## 0.11.1 — privacy hardening

Closes a set of metadata leaks, revives two privacy features that were wired
but dead, and narrows what secrets can escape through errors and logs.

### Breaking

- **`ScanInput` and `ScanHit` gained `blockNumber`.** A custom `NoteSource`
  must now populate it; it is what `addHits` writes to
  `StoredNote.firstSeenBlock`. Without it the selector's spend cooldown stays
  inert. The scanner worker wire format changed to match.
- **`SelectOpts.cooldownBlocks` now defaults to `DEFAULT_COOLDOWN_BLOCKS` (1)**
  rather than `0`. A note is no longer spendable in the block it arrived in,
  which is what breaks the same-block change-link heuristic. It only takes
  effect when a `tipBlock` is available — `prepareSpend` supplies one from the
  new optional `ChainAdapter.blockNumber()`, which `ViemChainAdapter`
  implements. Pass `cooldownBlocks: 0` to opt out.
- **`InsufficientCoverError.consolidate` is now `ConsolidateHint[]`**
  (`{ id, value }`) instead of `StoredNote[]`. The full record carried `rho`,
  `rcm` and `rcvDep` — note secrets — plus `cm`, which ties an error report to
  a specific pool leaf. The error is thrown on the ordinary cover-failure path,
  so it reaches whatever an application reports errors with. Target, asset and
  sum remain as typed fields but no longer appear in `message`.
- **`FmdClient.deleteSubscription` targets `DELETE /v1/subscriptions`** with
  the token in an `Authorization` header, not `/v1/subscriptions/<token>`.
  `GET /v1/matches` likewise carries the token as `Authorization: Bearer <hex>`
  instead of `?token=`. **Requires an fmd-webserver that accepts header auth.**
- **Detection γ is capped at `FMD_SENDER_GAMMA` (5), not `GAMMA_MAX`.**
  `detectionKey`, `detectionKeyFor` and `FmdClient.createSubscription` now
  throw for anything higher. Senders pack 5 clue bits and zero-pad the rest,
  while detection tests every bit of the key, so a longer key discarded roughly
  `1 - 2^-(γ - 5)` of the wallet's *own* notes instead of admitting more
  decoys — a subscription at the previously documented γ=8 missed ~87% of
  incoming notes. Raising the sender γ is a circuits change.
- `NetworkError.message` no longer splices the response body. It is still on
  `.body`.
- `X402PaymentError` no longer copies the resource URL into `context.url`, and
  `TxMiningError` no longer copies the tx hash into `context.txHash`. Both
  remain typed fields (`.resource`, `.txHash`); they are out of the bag that
  error reporters serialise wholesale.

### Added

- `connect({ fetchImpl })` — one seam for routing every default HTTP pluggable
  (FMD client, relayer submitter) through a proxy, SOCKS agent or recording
  shim. Previously this meant replacing `noteSource`, `treeStore`,
  `nullifierStore` and `submitter` by hand.
- `PRIVACY_REQUEST_DEFAULTS` — every SDK request now sends
  `credentials: "omit"`, `referrerPolicy: "no-referrer"` and
  `cache: "no-store"`. Browser defaults were sending the page origin as
  `Referer` and same-origin cookies to the relayer, the FMD host and the
  quoter. Caller `init` still overrides.
- `JsonClient.post` accepts `JsonRequestOptions`, so a credential can travel in
  a header instead of a URL. It previously ignored them.
- `hostPayerIndex(host)` — the x402 unshielded mechanism derives its ephemeral
  payer slot per resource host by default instead of always using slot 0. Every
  server previously saw the same `from` address, each publicly funded by a
  Lelantos withdrawal, so any two could confirm they shared a wallet by
  comparing it. Pass `index` to pin one slot deliberately.
- `FMD_SENDER_GAMMA`, `assertDetectionGamma`, `ConsolidateHint`,
  `DEFAULT_COOLDOWN_BLOCKS`.

### Removed

- The `RemoteProver` example in `SDK.md`, and "remote prover" from the
  `Prover` use-case list. The witness handed to a `Prover` contains `in_nsk`
  and every note plaintext, so a remote implementation hands over the wallet.

### Logging

- `deposit submitted` no longer logs the amount; `paying for resource` logs the
  host rather than the full URL.
