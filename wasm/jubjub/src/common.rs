//! Shared crate-internal helpers used by `lib.rs` and `decrypt.rs`:
//! byte<->scalar conversion, packed-point decoding with subgroup validation,
//! and blake2b hashing.

use blake2::digest::consts::{U12, U32};
use blake2::{Blake2b, Digest};
use num_bigint::{BigInt, Sign};

use crate::curve::{decompress_point, fr_one, fr_zero, Point};
use crate::{inv8, sub_order};

pub const FIELD_BYTES: usize = 32;

/// Read a 32B LE scalar and reduce mod sub_order. Single source of truth for
/// the JS↔WASM scalar boundary.
pub fn scalar_from_le(bytes: &[u8]) -> BigInt {
    BigInt::from_bytes_le(Sign::Plus, bytes) % sub_order()
}

/// Edwards identity check `(0, 1)`. Cached `Fr` constants.
pub fn is_identity(p: &Point) -> bool {
    p.x == fr_zero() && p.y == fr_one()
}

pub fn in_subgroup(p: &Point) -> bool {
    is_identity(&p.mul_scalar(sub_order()))
}

/// Read a 32B LE scalar and pair it with [`decode_cleared_point`].
///
/// `k · 8^-1 mod n`, so that `[k·8^-1]([8]p)` is `[k]q` for the prime-order part
/// `q` of `p`. Kept beside [`scalar_from_le`] so both forms of the JS↔WASM
/// scalar boundary live together.
pub fn cofactor_scalar_from_le(bytes: &[u8]) -> BigInt {
    (scalar_from_le(bytes) * inv8()) % sub_order()
}

/// `[8]p`, by three doublings.
///
/// Not `mul_scalar(8)`: that builds the full 16-entry window table whatever the
/// scalar, which costs more than the doublings it saves at this width.
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
/// identity for *every* key: one note that decrypts in every wallet and is
/// readable by any observer. Refused.
pub fn decode_cleared_point(packed: &[u8; FIELD_BYTES]) -> Option<Point> {
    let p = decompress_point(*packed).ok()?;
    let cleared = mul_by_cofactor(&p);
    if is_identity(&cleared) {
        None
    } else {
        Some(cleared)
    }
}

/// blake2b 32-byte digest over concatenated parts, in the shape the note KDF
/// expects (domain || epk || shared_packed).
pub fn blake2b_32(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Blake2b::<U32>::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// 12-byte blake2b digest. Used to derive a per-note AEAD nonce from epk.
pub fn blake2b_12(parts: &[&[u8]]) -> [u8; 12] {
    let mut h = Blake2b::<U12>::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}
