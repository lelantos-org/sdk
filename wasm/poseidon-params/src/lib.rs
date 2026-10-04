//! The slice of `light-poseidon`'s surface that the vendored permutation uses.
//!
//! `poseidon-wasm` renames this crate to `light-poseidon` in its manifest, so
//! its `src/poseidon/circom.rs`, vendored byte-for-byte from the backend where
//! that name is the real crate, compiles unedited and stays diffable.
//!
//! `light-poseidon` emits its constants as code, one arm per width from 2 to
//! 13, dispatched on a runtime `t`, so a wasm build carries every arm. Here
//! `build.rs` runs light-poseidon on the host and writes the served widths out
//! as data: the numbers are light-poseidon's own, and
//! `sdk/tests/vectors/poseidon.json` pins the resulting digests.
//!
//! Widths 2 to 7 (arities 1 to 6), the range `poseidon-wasm` exposes. Any
//! other width is an error.

use core::fmt;

use ark_ff::{BigInteger256, PrimeField};

mod table {
    /// One width's constants, as canonical little-endian limbs.
    pub(crate) struct Table {
        pub width: usize,
        pub full_rounds: usize,
        pub partial_rounds: usize,
        /// Round constants, `width` per round, flattened.
        pub ark: &'static [[u64; 4]],
        /// MDS matrix, row-major.
        pub mds: &'static [[u64; 4]],
    }

    include!(concat!(env!("OUT_DIR"), "/bn254_x5.rs"));
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
            "no bn254_x5 parameters for width {}: this crate builds widths {} to {} only",
            self.requested,
            table::MIN_WIDTH,
            table::MAX_WIDTH,
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
            let table = table::TABLES
                .iter()
                .find(|table| table.width == requested)
                .ok_or(PoseidonError { requested })?;

            Ok(PoseidonParameters {
                ark: table.ark.iter().copied().map(decode).collect(),
                mds: table
                    .mds
                    .chunks_exact(table.width)
                    .map(|row| row.iter().copied().map(decode).collect())
                    .collect(),
                full_rounds: table.full_rounds,
                partial_rounds: table.partial_rounds,
                width: table.width,
                alpha: table::ALPHA,
            })
        }
    }
}
