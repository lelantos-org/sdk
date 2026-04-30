# sdk/wasm

WASM crates consumed by `@lelantos/sdk`. Each crate builds via `wasm-pack` into its own `pkg/` (gitignored). SDK imports the generated JS / `.d.ts` from `sdk/src/**` via relative paths.

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

## Build

Requires [`just`](https://github.com/casey/just). `wasm-pack` auto-installed via `cargo install` if missing. Toolchain pinned in `rust-toolchain.toml` (nightly-2025-06-23, `wasm32-unknown-unknown`).

```bash
just build         # release, both crates
just build-dev     # dev (no wasm-opt), faster iteration
just check         # cargo check workspace, wasm target
just clippy        # -D warnings
just fmt / fmt-check
just clean         # cargo clean + rm pkg/
just size          # show .wasm sizes after build
```

Per-crate: `just prover-build`, `just jubjub-build` (and `-dev` variants).

## Output

Each crate emits `<crate>/pkg/` with `--target web`:
- `*.js`, `*_bg.wasm`, `*.d.ts`
- consumed via relative imports from `sdk/src/**`

## Notes

- Release profile: `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, symbols stripped.
- `wasm-opt`: `-O4` with SIMD, bulk-memory, threads, nontrapping-float-to-int, sign-ext, mutable-globals.
- `prover` parallel mode requires `crossOriginIsolated` (COOP/COEP headers) at runtime.
