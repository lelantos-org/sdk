//! Poseidon over BN254, circomlib-compatible, for arities 1 to 6.
//!
//! `src/poseidon/` is vendored byte-for-byte from
//! `backend/crates/crypto/src/poseidon/`, minus the `#[cfg(test)] mod tests;`
//! declaration, whose module is not vendored. `diff` against the backend
//! detects drift (`just drift`), and `tests/vectors/poseidon.json`, asserted by
//! both repos' suites, pins the digests.
//!
//! Arity 5 is `Poseidon(TAG_MERKLE, c0..c3)`, the Merkle internal node, which
//! dominates a full tree build. The SDK also hashes at 2, 3, 4 and 6 (key
//! derivation, commitments, nullifiers, rho, FMD bits); arity 1 serves the
//! circomlib anchor in the shared vectors. `poseidon-params` builds one
//! constant table per width, so each exposed arity costs its table in the
//! module.
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
/// The arities this module serves: the widths `poseidon-params` builds, less
/// the domain tag.
const MIN_ARITY: usize = 1;
const MAX_ARITY: usize = 6;

/// Hash 1 to 6 big-endian field elements into one, big-endian. The arity is
/// the input length in field elements.
///
/// Inputs must be canonical: one at or above the modulus is rejected, not
/// reduced, so two distinct byte strings cannot collide by wrapping. Errors
/// surface as JS exceptions, not traps.
#[wasm_bindgen]
pub fn poseidon(inputs_be: &[u8]) -> Result<Vec<u8>, JsValue> {
    let arity = inputs_be.len() / FE;
    if !inputs_be.len().is_multiple_of(FE) || !(MIN_ARITY..=MAX_ARITY).contains(&arity) {
        return Err(JsValue::from_str(&format!(
            "expected {MIN_ARITY} to {MAX_ARITY} field elements of {FE} bytes, got {} bytes",
            inputs_be.len()
        )));
    }
    let felts: Vec<&[u8]> = inputs_be.chunks_exact(FE).collect();
    poseidon::hash_bytes_be(&felts)
        .map(|d| d.to_vec())
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
