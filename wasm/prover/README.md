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
│   ├── lib.rs   # WASM façade, ProverSession
│   ├── zkey.rs  # snarkjs zkey parser → arkworks ProvingKey
│   └── wtns.rs  # circom .wtns witness parser
├── pkg/         # wasm-pack output (gitignored)
└── Cargo.toml
```

The workspace manifest, `justfile`, `rust-toolchain.toml` and
`.cargo/config.toml` live one level up, in `wasm/`.

## Prereqs

- Rust nightly with the `rust-src` component, pinned in
  `wasm/rust-toolchain.toml` and read by `rustup` automatically.
- `wasm-pack` on PATH; `just build` installs it via `cargo` if missing.
- `just` for the recipe runner.

## Build

Recipes run from `wasm/`:

```bash
just prover-build       # release wasm-pack build (web target) → pkg/
just prover-build-dev   # faster, no wasm-opt, debug assertions on
just prover-build-trace # release with the `trace` feature
just check              # cargo check, wasm target
just clippy             # -D warnings
just size               # build, then print .wasm sizes
```

`just build` builds every crate in the workspace. `pkg/` holds the ES module,
`.d.ts` and `prover_bg.wasm`, consumed by `bench/` and `sdk/`.

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

## Prover and QAP reduction

The prover is `taceo-groth16`, not `ark-groth16`. `ark-groth16` still supplies
`ProvingKey` and `Proof`; it does not supply the proving path.

**Worth it on phones, a wash on a big desktop.** Measured on 4x6, 5 iterations,
against the previous `ark-groth16` 0.5 build:

| device | threads | before (min) | after (min) | |
|--------|--------:|-------------:|------------:|---|
| iPhone, Safari | 4 | 2996 ms | 2471 ms | **-17.5%** |
| Mac, Chrome | 16 | 876 ms | 879 ms | par |

The iPhone moved on every statistic — mean, median, min and max together — so it
is not noise, and it is the device where proving hurts most. Both figures are
end-to-end; roughly a quarter of the wall clock is `circom_runtime` computing the
witness in JS (~240 ms of ~960 ms on the Mac), which no change to this crate can
touch, so the prover's own share improved by more than the table shows.

The split between the two devices is the thread count, and it follows from what
the swap actually trades. The win is arithmetic: buckets accumulated in affine
form behind one deferred inversion, rather than the extended-Jacobian form
`ark-ec` 0.6 uses. The cost is a fixed ~8 MB digit array per MSM, plus more
memory indirection — cheap on a native core, less so under wasm's bounds-checked
loads. Arithmetic divides across threads; that allocation does not. At 16 threads
the arithmetic is cut sixteen ways while the overhead stays whole and cancels the
gain (and shows up as a 26% run-to-run spread in `groth16`, where the old build
was steady). At 4 threads the arithmetic dominates and the gain survives.

Natively, where neither wasm's memory penalty nor a 4-thread ceiling applies, the
same swap is a measured ~1.7x on both `tree_update_batch` and this 4x6 zkey. The
other half of the native win is a defect that does not bite here: `ark-ec` 0.6
splits an MSM into `num_threads / 2` chunks and sizes the Pippenger window from
the *chunk* rather than the input, so more threads means a smaller window and
more bucket work.

Proving is overwhelmingly MSM on every target: natively the five MSMs are **86%**
of proving time and the six size-2^17 FFTs the other 14%. Use the `trace` feature
to check that split in a browser.

`taceo-ark-algebra` uses no `rayon::ThreadPoolBuilder` — only `current_num_threads`
and parallel iterators — so it runs under `wasm-bindgen-rayon` unchanged.

Its `CircomReduction` mirrors snarkjs' witness-map computation (odd coefficients
of `(AB - C)` in a 2x domain) instead of the arkworks default `(AB - C)/Z`,
which is what the vendored `qap.rs` used to do here and why that file is gone.
Required either way, so proofs verify against snarkjs-generated verifier keys.

Two consequences worth knowing:

- It checks the witness length against the zkey's `nVars` and refuses a mismatch,
  where `ark-groth16` silently truncated to the shorter of bases and scalars. A
  witness that does not match the proving key cannot produce a verifying proof,
  so failing at the call beats failing at the verifier.
- It requires Rust 1.90, which is why `wasm/rust-toolchain.toml` moved from
  `nightly-2025-06-23` to `nightly-2026-04-27`.

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

`.github/workflows/wasm.yml` runs `fmt-check` and `clippy` on changes under
`wasm/**`. The release build runs once in `ci.yml`'s `wasm` job, which publishes
`wasm/*/pkg` as an artifact for the jobs that need it.
