//! The slice of `light-poseidon`'s surface that the vendored permutation uses.
//!
//! `poseidon-wasm` renames this crate to `light-poseidon` in its manifest, so
//! `src/poseidon/circom.rs` — vendored byte-for-byte from the backend, where
//! that name is the real crate — keeps compiling unedited and stays diffable.
//! The numbers are light-poseidon's own: `build.rs` runs it on the host and
//! writes the table out, so they are identical by construction rather than by
//! transcription. `sdk/tests/vectors/poseidon.json` pins the far side.
//!
//! # Why not the crate
//!
//! `light-poseidon` emits its constants as code, one arm per width, dispatched
//! on a runtime `t`. Nothing drops the arms the caller never asks for, so the
//! module reached `wasm-opt` at ~2 MB and only `-O4` — 12+ minutes of constant
//! propagation through 43k lines — brought it back to ~190 KB. Resolving the
//! width at build time makes that work unnecessary rather than faster.
//!
//! **Width 6 only** (arity 5). That is the one width `poseidon-wasm` exposes;
//! every other arity the SDK uses stays on the JS backend. Asking for another
//! width is an error here rather than a silently missing table.

use core::fmt;

use ark_ff::{BigInteger256, PrimeField};

mod table {
    include!(concat!(env!("OUT_DIR"), "/bn254_x5_w6.rs"));
}

/// Stands in for `light_poseidon::PoseidonError`.
///
/// Only `Display` is used: the vendored caller wraps it in its own
/// `PoseidonError::Params(e.to_string())`.
#[derive(Debug)]
pub struct PoseidonError {
    requested: usize,
}

impl fmt::Display for PoseidonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "no bn254_x5 parameters for width {}: this crate builds width {} only",
            self.requested,
            table::WIDTH,
        )
    }
}

impl std::error::Error for PoseidonError {}

/// Stands in for `light_poseidon::PoseidonParameters`.
pub struct PoseidonParameters<F: PrimeField> {
    /// Round constants, `width` per round, flattened.
    pub ark: Vec<F>,
    /// MDS matrix, one inner `Vec` per row.
    pub mds: Vec<Vec<F>>,
    /// Rounds applying the S-box to the whole state.
    pub full_rounds: usize,
    /// Rounds applying the S-box to the first element only.
    pub partial_rounds: usize,
    /// State width: arity plus the domain tag.
    pub width: usize,
    /// S-box exponent.
    pub alpha: u64,
}

/// Canonical little-endian limbs -> field element, inverting the
/// `into_bigint().0` that `build.rs` writes.
fn decode<F: PrimeField + From<BigInteger256>>(limbs: [u64; 4]) -> F {
    F::from(BigInteger256::new(limbs))
}

pub mod parameters {
    /// Mirrors `light_poseidon::parameters::bn254_x5`.
    pub mod bn254_x5 {
        use ark_ff::{BigInteger256, PrimeField};

        use crate::{decode, table, PoseidonError, PoseidonParameters};

        /// Round constants and MDS matrix for state width `t`.
        ///
        /// Signature matches `light_poseidon`'s, `From<BigInteger256>` bound
        /// included — that is what the limb table decodes through.
        pub fn get_poseidon_parameters<F: PrimeField + From<BigInteger256>>(
            t: u8,
        ) -> Result<PoseidonParameters<F>, PoseidonError> {
            let requested = usize::from(t);
            if requested != table::WIDTH {
                return Err(PoseidonError { requested });
            }

            Ok(PoseidonParameters {
                ark: table::ARK.iter().copied().map(decode).collect(),
                mds: table::MDS
                    .chunks_exact(table::WIDTH)
                    .map(|row| row.iter().copied().map(decode).collect())
                    .collect(),
                full_rounds: table::FULL_ROUNDS,
                partial_rounds: table::PARTIAL_ROUNDS,
                width: table::WIDTH,
                alpha: table::ALPHA,
            })
        }
    }
}
