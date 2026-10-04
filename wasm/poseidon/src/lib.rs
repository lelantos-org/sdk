//! Poseidon-5 over BN254, circomlib-compatible.
//!
//! `src/poseidon/` is vendored byte-for-byte from
//! `backend/crates/crypto/src/poseidon/`, minus the `#[cfg(test)] mod tests;`
//! declaration, whose module is not vendored. `diff` against the backend
//! detects drift (`just drift`), and `tests/vectors/poseidon.json`, asserted by
//! both repos' suites, pins the digests.
//!
//! Arity 5 only: `Poseidon(TAG_MERKLE, c0..c3)`, the Merkle internal node,
//! which dominates a full tree build. Every other arity the SDK uses (2, 3, 4,
//! 6 — key derivation, nullifiers, rho, FMD bits) runs a handful of times per
//! operation and stays on the JS backend; [`poseidon5`] explains what exposing
//! one takes.
//!
//! Built without shared memory, unlike the sibling `jubjub` and `prover`
//! crates: Poseidon is single-threaded and needs no atomics, so this module
//! loads for consumers without cross-origin isolation.

// `allow` here and not in the vendored file: `hash()` (the `Fq`-taking
// variant) has no caller in this crate, and editing the vendored source would
// break its byte-identity with the backend.
#[allow(dead_code)]
mod poseidon;

use wasm_bindgen::prelude::*;

/// Bytes per field element on the boundary.
const FE: usize = 32;
/// The one arity this module serves.
const ARITY: usize = 5;

/// Hash 5 big-endian field elements into one, big-endian.
///
/// Inputs must be canonical: one at or above the modulus is rejected, not
/// reduced, so two distinct byte strings cannot collide by wrapping. Errors
/// surface as JS exceptions, not traps.
///
/// The arity is fixed because the round constants are a build-time table and
/// `poseidon-params` builds one width: 6, this arity plus the domain tag.
/// Another arity needs a function here and a width there, not an arity
/// argument.
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
