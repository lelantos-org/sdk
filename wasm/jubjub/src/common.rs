//! Crate-internal helpers for `lib.rs` and `decrypt.rs`: byte<->scalar
//! conversion, the subgroup check, packed-point decoding with cofactor
//! clearing, and blake2b hashing.

use blake2::digest::consts::{U12, U32};
use blake2::{Blake2b, Digest};
use num_bigint::{BigInt, Sign};

use crate::curve::{decompress_point, fr_one, fr_zero, Point};
use crate::{inv8, sub_order};

pub const FIELD_BYTES: usize = 32;

/// A 32B LE scalar, reduced mod `sub_order`.
pub fn scalar_from_le(bytes: &[u8]) -> BigInt {
    BigInt::from_bytes_le(Sign::Plus, bytes) % sub_order()
}

/// Whether `p` is the Edwards identity `(0, 1)`.
pub fn is_identity(p: &Point) -> bool {
    p.x == fr_zero() && p.y == fr_one()
}

pub fn in_subgroup(p: &Point) -> bool {
    is_identity(&p.mul_scalar(sub_order()))
}

/// A 32B LE scalar `k` as `k · 8^-1 mod n`, the counterpart of
/// [`decode_cleared_point`]: `[k·8^-1]([8]p)` is `[k]q` for the prime-order
/// part `q` of `p`.
pub fn cofactor_scalar_from_le(bytes: &[u8]) -> BigInt {
    (scalar_from_le(bytes) * inv8()) % sub_order()
}

/// `[8]p`, by three doublings. `mul_scalar(8)` would first build its 16-entry
/// window table.
fn mul_by_cofactor(p: &Point) -> Point {
    p.projective().double().double().double().affine()
}

/// Decompress a packed point and clear its cofactor, rejecting the identity.
///
/// Baby-Jubjub is `Z_8 x Z_n`, so a packed point may carry an 8-torsion term:
/// `p = T + q`. `[8]p` annihilates `T`, and a scalar carrying the matching
/// `8^-1` (see [`cofactor_scalar_from_le`]) undoes the cofactor on `q`. The
/// pair yields `[k]q` — equal to `[k]p` when `p` is honest, and free of the
/// torsion term when it is not.
///
/// An identity result means `p` was pure torsion, whose shared secret is the
/// identity for every key: one note that decrypts in every wallet and is
/// readable by any observer. Such a point is rejected.
pub fn decode_cleared_point(packed: &[u8; FIELD_BYTES]) -> Option<Point> {
    let p = decompress_point(*packed).ok()?;
    let cleared = mul_by_cofactor(&p);
    if is_identity(&cleared) {
        None
    } else {
        Some(cleared)
    }
}

/// 32-byte blake2b digest of the concatenated parts.
pub fn blake2b_32(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Blake2b::<U32>::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// 12-byte blake2b digest of the concatenated parts.
pub fn blake2b_12(parts: &[&[u8]]) -> [u8; 12] {
    let mut h = Blake2b::<U12>::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}
