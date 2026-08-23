//! Poseidon-5 over BN254, circomlib-compatible.
//!
//! `src/poseidon/` is **vendored byte-for-byte** from
//! `backend/crates/fmd-crypto/src/poseidon/` (only the `#[cfg(test)] mod
//! tests;` line is dropped, since that module is not vendored). Keeping it
//! diffable is deliberate: `diff` against the backend is the cheap drift
//! check, and `tests/vectors/poseidon.json` — asserted by both repos' suites —
//! is the one that survives the copies being edited independently.
//!
//! **Arity 5 only.** That is `Poseidon(TAG_MERKLE, c0..c3)`, the Merkle
//! internal node, which is ~349,525 of the calls in a full tree build. Every
//! other arity the SDK uses (2, 3, 4, 6 — key derivation, nullifiers, rho,
//! FMD bits) runs a handful of times per operation and stays on the JS
//! backend, because exposing them here is not free: see [`poseidon5`].
//!
//! Built **without shared memory**, unlike the sibling `jubjub` and `prover`
//! crates. Poseidon is single-threaded, so it needs no atomics, and omitting
//! them means this module loads for consumers without cross-origin isolation.

// `allow` here rather than in the vendored file: `hash()` (the `Fq`-taking
// variant) has no caller in this crate, and editing the vendored source to
// silence that would cost the byte-identity that makes `diff` against the
// backend a drift check.
#[allow(dead_code)]
mod poseidon;

use wasm_bindgen::prelude::*;

/// Bytes per field element on the boundary.
const FE: usize = 32;
/// The one arity this module serves.
const ARITY: usize = 5;

/// Hash 5 big-endian field elements into one, big-endian.
///
/// Inputs must be canonical — one at or above the modulus is rejected rather
/// than reduced, so two distinct byte strings cannot be made to collide by
/// wrapping. Errors surface as JS exceptions rather than traps.
///
/// # Why the arity is fixed
///
/// The round constants are a build-time table, and `poseidon-params` builds
/// one width: 6, this arity plus the domain tag. Exposing another arity means
/// another table, so add arities by adding a function here *and* a width
/// there — not by taking the arity as an argument.
///
/// Deriving the width at run time is what the crate did until it cost 12
/// minutes a build; `poseidon-params` carries that measurement.
#[wasm_bindgen]
pub fn poseidon5(inputs_be: &[u8]) -> Result<Vec<u8>, JsValue> {
    if inputs_be.len() != ARITY * FE {
        return Err(JsValue::from_str(&format!(
            "expected {} bytes, got {}",
            ARITY * FE,
            inputs_be.len()
        )));
    }
    let felts: Vec<&[u8]> = (0..ARITY)
        .map(|i| &inputs_be[i * FE..(i + 1) * FE])
        .collect();
    poseidon::hash_bytes_be(&felts)
        .map(|d| d.to_vec())
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
