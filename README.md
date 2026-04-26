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

## Layout

```
src/
  crypto/      poseidon, jubjub, tags, derive, commit, nullifier, merkle
  keys.ts      key hierarchy
  metamask.ts  EIP-712 → nsk
  jubjub.ts    re-export
  address.ts   bech32m
  fmd.ts       Niwl
  note-encrypt.ts
  notes.ts
  nullifier-client.ts
  cache.ts
  prover.ts
```

## Circuit parity

`buildNoteCommitment` and `buildNullifier` in `crypto/` are byte-identical
to the templates in `circuits/src/lib/note.circom`.

`circuits/src/test/helpers.ts` re-exports from this SDK so circuit tests
exercise the same code path.
