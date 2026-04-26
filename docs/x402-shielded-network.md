# The `shielded:<chainId>` network family for x402

**Status:** draft. Implemented by `@lelantos-org/sdk` (`./x402`); intended for
submission to `x402-foundation/x402` as
`specs/schemes/exact/scheme_exact_shielded.md`.

## Summary

This document specifies an implementation of the **`exact` scheme** for
payments made inside a shielded pool — a system where transfers reveal
neither sender, recipient, nor amount on the settlement chain.

It defines a network family, not a new scheme. The chain-agnostic `exact`
specification defines the scheme as "a scheme that transfers a specific
amount of funds from a client to a resource server", and is extended by
per-network implementation documents (Solana, Stellar, TON, Sui, Starknet
each have one). A shielded transfer has exactly those semantics, so it needs
a network, not a scheme.

Nothing here requires changes to `@x402/core`: `scheme` is an unvalidated
non-empty string, `network` is checked only for CAIP-2 shape, `asset` and
`payTo` carry no format constraints, and `payload` is opaque to the core
package.

## Motivation

An autonomous agent paying per API call emits a public, itemised, permanently
linkable record of everything it read, on every existing `exact`
implementation. The amounts reveal which endpoints it used; the payer address
links every call to one operator. For an agent acting on someone's behalf,
that record is the user's browsing history.

A shielded pool removes it. What the settlement chain sees is that *some*
transfer happened; who paid whom, and how much, is visible only to the payer
and to whoever holds the recipient's viewing key.

## Network identifier

```
network = "shielded:" <settlement-chain-reference>
```

The reference is the chain id where the pool settles — `shielded:11155111`
for a pool on Sepolia. This keeps the identifier anchored to a real chain
(there is always one place value ultimately lives), while giving shielded
payments their own namespace so an `@x402/core` client can register a
shielded mechanism and the standard `eip155:*` mechanism side by side without
collision.

Several pools may exist on one chain; `extra.pool` disambiguates.

## Payment requirements

| Field | Value |
|---|---|
| `scheme` | `"exact"` |
| `network` | `"shielded:<chainId>"` |
| `amount` | Pool-native units, decimal integer string |
| `asset` | Pool-native asset identifier |
| `payTo` | Pool-native shielded address |
| `maxTimeoutSeconds` | See *Timing* below — MUST allow for proof generation |
| `extra.pool` | Implementation id, e.g. `"lelantos"` |
| `extra.poolAddress` | Pool contract on the settlement chain |
| `extra.scale` | Pool units → token base units multiplier, decimal string |
| `extra.paymentFlow` | `"upfront"` |

`amount` and `asset` are denominated **by the pool**, not by the settlement
chain. A pool that internally addresses assets by a registry id and stores
values scaled down from ERC-20 base units quotes both in its own terms;
`extra.scale` is what lets a client relate them to the underlying token.

```jsonc
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "shielded:11155111",
      "amount": "1500",
      "asset": "1",
      "payTo": "sswap1qq…",
      "maxTimeoutSeconds": 120,
      "extra": {
        "pool": "lelantos",
        "poolAddress": "0x0165878A594ca255338adfa4d48449f69242Eb8F",
        "scale": "1000000000000000",
        "paymentFlow": "upfront"
      }
    }
  ]
}
```

## Payment payload

```jsonc
{
  "pool": "lelantos",
  "txHash": "0x…",
  "commitment": "0x…",
  "asset": "1",
  "amount": "1500"
}
```

| Field | Meaning |
|---|---|
| `pool` | MUST equal `extra.pool` |
| `txHash` | Settlement-chain transaction carrying the transfer |
| `commitment` | Note commitment of the **recipient's** output |
| `asset` | Echo of `PaymentRequirements.asset` |
| `amount` | Echo of `PaymentRequirements.amount` |

A shielded transfer produces several output commitments; exactly one belongs
to the recipient and the rest are change or padding. The payload names the
recipient's. Quoting any other commitment yields a payment the server cannot
detect, and is indistinguishable from not paying.

## Payment flow

`extra.paymentFlow` is `"upfront"`: the client submits the transfer, then
presents the receipt. The server verifies before serving; there is no
separate settle step.

The client MUST NOT present a payload for a transfer it has not submitted.

> **Why not `authorization`?** x402's default flow — the client hands over an
> unsubmitted authorization and the server settles it — is more
> trust-minimal, and is the better long-term shape here: a pool transfer can
> be built, proven, and handed over without being broadcast, and a
> facilitator could relay it at settle time. It requires a facilitator that
> can relay pool transactions. Until such a facilitator exists, `upfront` is
> the honest description of what actually happens, and the trade is real: a
> server can take payment and not serve. Clients SHOULD therefore enforce
> spend limits, and SHOULD prefer servers they can hold accountable.

## Verification

The resource server MUST:

1. Reject unless `payload.pool` equals the `extra.pool` it advertised.
2. Detect the note at `payload.commitment` using its own viewing key.
   Detection is what proves the payment was to *this* server — `payTo` in the
   requirements is not evidence by itself.
3. Check the detected note's value equals `amount` and its asset equals
   `asset`.
4. Check `txHash` is a settlement-chain transaction that includes
   `commitment`, and is final to the server's satisfaction.
5. Bind `commitment` to this resource on first use, and reject any later
   presentation of the same `commitment` for a different resource.

Step 5 is the replay defence. A note commitment is unique and single-use
within a pool, so pinning it on first sight is sufficient; no additional
nonce is required.

Servers MUST NOT treat `payload.amount`/`payload.asset` as authoritative —
they are conveniences for logging. Only the detected note is evidence.

## Timing

Generating a shielded transfer requires a zero-knowledge proof, which takes
seconds rather than milliseconds. Servers SHOULD advertise a
`maxTimeoutSeconds` of at least 60. Clients SHOULD refuse an offer whose
window is shorter than their measured proving time rather than pay into a
window that has already closed; the reference implementation refuses below
20 seconds by default.

## Privacy considerations

- The settlement chain reveals that a pool transaction occurred, and its
  timing. Amount, sender, and recipient are not revealed.
- `payTo` in the requirements is a public, long-lived identifier for the
  server. It links the *server's* payments together, not the client's.
- Presenting `txHash` to the server reveals to that server which on-chain
  transaction was the client's. A server that also observes the chain can use
  this to correlate one payment with one transaction. It learns nothing about
  the client's other payments, and nothing about the client's balance.
- Clients paying many servers SHOULD NOT reuse a transfer across them.

## Reference implementation

`@lelantos-org/sdk`, subpath `./x402`:

```ts
import { connect } from "@lelantos-org/sdk";
import { x402 }    from "@lelantos-org/sdk/x402";

const wallet = await connect({ mnemonic, network: "anvil" });
await wallet.sync();

const pay = x402(wallet, { budget: { total: "5" } });
await pay("https://api.example.com/premium");
```

Or registered on an `@x402/core` client:

```ts
import { shieldedExact, shieldedNetwork } from "@lelantos-org/sdk/x402";

client.register(shieldedNetwork(await wallet.chain.chainId()), shieldedExact(wallet));
```

`extra.pool` is `"lelantos"`; `asset` is a MASP registry id; `amount` is in
circuit units (`tokenBaseUnits = amount × scale`); `payTo` is a bech32m
`sswap1…` address.

The wire contract above is asserted in `src/x402/shielded.test.ts` — those
tests and this document are meant to be changed together.
