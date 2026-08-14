//! Shared crate-internal helpers used by `lib.rs` and `decrypt.rs`:
//! byte<->scalar conversion, packed-point decoding with subgroup validation,
//! and blake2b hashing.

use blake2::digest::consts::{U12, U32};
use blake2::{Blake2b, Digest};
use num_bigint::{BigInt, Sign};

use crate::curve::{decompress_point, fr_one, fr_zero, Point};
use crate::sub_order;

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

/// Decompress a 32B circomlibjs-packed point and verify it lies in the
/// prime-order subgroup. Returns `None` on parse fail or off-subgroup —
/// callers in fused paths treat both as "not for me".
pub fn decode_subgroup_point(packed: &[u8; FIELD_BYTES]) -> Option<Point> {
    let p = decompress_point(*packed).ok()?;
    if in_subgroup(&p) {
        Some(p)
    } else {
        None
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
