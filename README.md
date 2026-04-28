# @lelantos/sdk

Client SDK for the Lelantos MASP. Owns:

- Key hierarchy: `nsk → ivk → pk → dk` (Poseidon, BN254).
- Baby-Jubjub primitives: `H_BASE`, `hashToAssetGen`, `valueCommit`.
- Note commitment + nullifier (byte-identical to `circuits/src/lib/note.circom`).
- Quaternary Poseidon Merkle tree (TAG_MERKLE = 5).
- bech32m payment addresses (HRP `lelantos`, payload = `pk_d || dk`).
- MetaMask key derivation (EIP-712 → keccak256 → mod r).
- Note encryption (ephemeral Baby-Jubjub ECDH → Blake2b KDF → ChaCha20-Poly1305).
- FMD (Niwl, γ=5).
- snarkjs prover wrapper.
- Witness builders for the 2x2 transact and tree_update circuits.
- SNARK public-input compression (matches `MASP.sol` byte-for-byte).
- Relayer HTTP client + operator (canonical tree, tree_update prover, on-chain submit).
- Wallet-side tree sync (lazy-root path verification against `isKnownRoot`).

## Layout

```
src/
  crypto/             poseidon, jubjub, tags, derive, commit, nullifier, merkle, bytes
  witness/
    tree-update.ts    tree_update circuit witness
  witness.ts          transact_2x2 circuit witness
  snark-compression.ts  flatten + (z, y) compression for both circuits
  keys.ts             key hierarchy
  metamask.ts         EIP-712 → nsk
  jubjub.ts           re-export
  address.ts          bech32m
  fmd.ts              Niwl
  note-encrypt.ts
  notes.ts
  cache.ts
  prover.ts           snarkjs wrapper
  relayer.ts          wallet → relayer HTTP client
  operator.ts         relayer-internal: canonical tree + tree_update + transact() submit
  sync.ts             rootFromPath / verifyPath
  index.ts            barrel
```

## Circuit parity

`buildNoteCommitment` and `buildNullifier` in `crypto/` are byte-identical
to the templates in `circuits/src/lib/note.circom`.

`circuits/src/test/helpers.ts` re-exports from this SDK so circuit tests
exercise the same code path.
