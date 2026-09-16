# sdk/wasm

WASM crates consumed by `@lelantos-org/sdk`. Each builds via `wasm-pack` into
its own `pkg/` (gitignored); `sdk/src/**` imports the generated JS and `.d.ts`
by relative path.

## Crates

### `prover/`
Browser Groth16 prover. Reads snarkjs `.zkey` + circom `.wtns`, runs `ark-groth16` (rayon-parallel when `crossOriginIsolated`).

Public WASM API:
- `init()` — wasm-pack default
- `initThreadPool(n)` — from `wasm-bindgen-rayon` (parallel feature)
- `new ProverSession(zkeyU8)` — parses zkey once
- `session.prove(wtnsU8)` → snarkjs `Groth16Proof` shape:
  ```
  { piA: [x,y,"1"],
    piB: [[x.c0,x.c1],[y.c0,y.c1],["1","0"]],
    piC: [x,y,"1"],
    publicSignals: [decimal strings] }
  ```

Features: `parallel` (default) — enables rayon + `wasm-bindgen-rayon`.

### `jubjub/`
Baby-Jubjub backend. Drop-in replacement for circomlibjs `Jubjub`. Vendored Edwards arithmetic (adapted from `babyjubjub-rs`, MIT). No `blake-hash` / `poseidon-rs` / signatures — keeps wasm minimal.

Wire conventions:
- field element: 32 bytes LE
- point (in/out): 64 bytes = `x_LE || y_LE`
- packed point: 32 bytes = `y_LE` with high bit of byte 31 = sign(x). Matches `babyJub.packPoint` exactly.

Exports: `base8`, `sub_order_le`, `add_point`, `mul_point_escalar`, `in_subgroup`, `pack_point`, `unpack_point` (+ decrypt / fmd modules).

### `poseidon/`
Poseidon-5 over BN254, circomlib-compatible. **Arity 5 only** — that is
`Poseidon(TAG_MERKLE, c0..c3)`, ~349,525 of the calls in a full tree build.
Every other arity the SDK uses stays on the JS backend, since each width here
costs a round-constant table in the binary.

`src/poseidon/` is vendored byte-for-byte from
`backend/crates/crypto/src/poseidon/`, so `just drift` catches an edit to
either side. `tests/vectors/poseidon.json`, asserted by both repos, catches
semantic drift.

Export: `poseidon5(inputs_be)` — 5 × 32 bytes BE in, 32 bytes BE out.

### `poseidon-params/`
The slice of `light-poseidon`'s surface the vendored permutation uses. Renamed
to `light-poseidon` in `poseidon/`'s manifest so the vendored files need no
edits. Not built to WASM on its own.

## Build

Requires [`just`](https://github.com/casey/just). `wasm-pack` auto-installed via `cargo install` if missing. Toolchain pinned in `rust-toolchain.toml` — channel, components and `wasm32-unknown-unknown`, all in that one file, which is also what CI reads.

```bash
just build         # release, all three crates
just build-dev     # dev (no wasm-opt), faster iteration
just check         # cargo check workspace, wasm target
just clippy        # -D warnings
just fmt / fmt-check
just drift         # diff poseidon/src/poseidon against the backend copy
just bench         # criterion benches
just audit         # cargo audit
just clean         # cargo clean + rm pkg/
just size          # show .wasm sizes after build
```

Per-crate: `just prover-build`, `just jubjub-build`, `just poseidon-build` (and
`-dev` variants). CI (`.github/workflows/wasm.yml`) runs `fmt-check` and
`clippy` on changes under `wasm/**`.

## Output

Each crate emits `<crate>/pkg/` with `--target web`:
- `*.js`, `*_bg.wasm`, `*.d.ts`
- consumed via relative imports from `sdk/src/**`

## Notes

- Release profile: `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, symbols stripped.
- `wasm-opt`: `-O4` with SIMD, bulk-memory, threads, nontrapping-float-to-int, sign-ext, mutable-globals.
- `prover` parallel mode requires `crossOriginIsolated` (COOP/COEP headers) at runtime.
