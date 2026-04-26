# prover

Browser-side Groth16 prover for the MASP circuits. Rust + arkworks compiled to
WASM via `wasm-pack`, with rayon multi-threading through `wasm-bindgen-rayon`
when the page is cross-origin isolated.

Public API mirrors snarkjs file formats: takes a snarkjs `.zkey` and a circom
`.wtns` byte buffer, returns proof points + public signals.

## Layout

```
prover/
├── src/
│   ├── lib.rs          # WASM façade, ProverSession
│   ├── zkey.rs         # snarkjs zkey parser → arkworks ProvingKey
│   ├── wtns.rs         # circom .wtns witness parser
│   └── qap.rs          # CircomReduction (snarkjs-compatible R1CS→QAP)
├── pkg/                # wasm-pack output (gitignored)
├── .cargo/config.toml  # wasm32 + atomics/bulk-memory/simd128 rustflags
├── rust-toolchain.toml # pinned nightly + rust-src + wasm32 target
├── Cargo.toml
└── justfile
```

## Prereqs

- Rust nightly (pinned in `rust-toolchain.toml`) with `rust-src` component.
  `rustup` reads the toolchain file automatically.
- `wasm-pack` on PATH. `just build` auto-installs via `cargo install wasm-pack`
  if missing.
- `just` for the recipe runner.

## Build

```bash
just build       # release wasm-pack build (web target) → pkg/
just build-dev   # faster, no wasm-opt, debug assertions on
just check       # cargo check (no artifact)
just clippy      # clippy with -D warnings
just fmt         # rustfmt
just clean       # cargo clean + rm -rf pkg
just size        # build, then print bg.wasm size
```

`pkg/` contains the loadable ES module + `.d.ts` + the wasm binary
(`prover_bg.wasm`). Consumed by `bench/` and `sdk/`.

## Public API

```ts
import init, { ProverSession, initThreadPool } from "./pkg/prover.js";

await init();
// IMPORTANT: must `await` before any prove() — without it, FFT/MSM run
// single-threaded silently. No-op (and harmless) when not cross-origin isolated.
if (crossOriginIsolated) await initThreadPool(navigator.hardwareConcurrency);

const session = new ProverSession(zkeyU8);          // parse zkey once
const { piA, piB, piC, publicSignals } = session.prove(wtnsU8);
```


Output mirrors snarkjs `Groth16Proof` (decimal strings):
- `piA: [x, y, "1"]` — G1 affine
- `piB: [[x.c0, x.c1], [y.c0, y.c1], ["1", "0"]]` — G2 over Fq2 (ark `c0 + c1·u`
  matches circom)
- `piC: [x, y, "1"]` — G1 affine
- `publicSignals: string[]`

Drop-in compatible with `snarkjs.groth16.verify` after renaming
`piA → pi_a` etc.

`new ProverSession(...)` parses the zkey eagerly and keeps the proving key + R1CS
matrices in memory — reuse the session across proofs.

## Threading

Multi-threading depends on **cross-origin isolation** (browser-gated, requires
SAB). The page must serve with:

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
```

…and be a **secure context** (HTTPS or `localhost`). LAN IPs over plain HTTP do
**not** count — mobile Safari falls back to single-thread.

When isolation is missing, skip `initThreadPool` (or call it and ignore failure)
— the prover still runs single-threaded. Expect ~3–4× slower.

## QAP reduction

`CircomReduction` in `qap.rs` mirrors snarkjs' witness-map computation (odd
coefficients of `(AB - C)` in a 2× domain) instead of the arkworks default
`(AB - C)/Z`. Required so proofs verify against snarkjs-generated verifier
keys.

## File formats

- **zkey** — snarkjs binary, sections 1–10. Parser at [src/zkey.rs](src/zkey.rs).
  Coefficient field elements are stored as `v · R²`; `read_fr` does the single
  Montgomery reduction down to internal `v · R` form.
- **wtns** — circom witness binary. Magic `wtns`, section 1 = header
  (n8 + prime + nWitness), section 2 = `nWitness × n8` LE bytes. Parser at
  [src/wtns.rs](src/wtns.rs). BN254 only (asserts `n8 == 32`).

## Build flags

`.cargo/config.toml` enables `+atomics,+bulk-memory,+mutable-globals,+simd128`
on the wasm32 target — needed for `wasm-bindgen-rayon` and SIMD-accelerated
arkworks. `[unstable] build-std = ["panic_abort", "std"]` rebuilds std with
those features.

`Cargo.toml` release profile: `lto = "fat"`, `codegen-units = 1`,
`wasm-opt = ["-O4", "--enable-simd", "--enable-bulk-memory", "--enable-threads"]`.

## Known noise

`warning: unstable feature specified for -Ctarget-feature: atomics` per build —
expected. `+atomics` is unstable but load-bearing for threading; no lint to
suppress it cleanly.

## CI

`.github/workflows/prover.yml` runs `fmt-check`, `clippy`, and `build` on
PRs that touch `prover/**`. The built `pkg/` is uploaded as an artifact
(7-day retention).
