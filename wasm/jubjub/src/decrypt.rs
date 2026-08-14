//! Fused trial-decrypt path. Inlines the per-note pipeline:
//!   decompress epk → subgroup check → ECDH (epk · ivk) → blake2b KDF
//!   → ChaCha20-Poly1305 decrypt
//! into one wasm-bindgen entry. Cuts four FFI hops to one and replaces
//! pure-JS @noble blake2b + chacha with RustCrypto's wasm32 impls.
//!
//! Wire format must match `sdk/src/notes/encrypt.ts` byte-for-byte:
//!   key   = blake2b("lelantos.note.kdf.v1"  || epk_packed || shared_packed, 32B)
//!   nonce = blake2b("lelantos.note.nonce.v1" || epk_packed, 12B)
//!   ct    = ChaCha20-Poly1305(key, nonce, plaintext)
//!
//! Per-note nonce derived from epk gives defense-in-depth against any future
//! code path that reuses an AEAD key with different ephemeral data.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

use crate::common::{blake2b_12, blake2b_32, decode_subgroup_point, scalar_from_le, FIELD_BYTES};

const KDF_DOMAIN: &[u8] = b"lelantos.note.kdf.v1";
const NONCE_DOMAIN: &[u8] = b"lelantos.note.nonce.v1";

#[wasm_bindgen]
pub fn try_decrypt_note(
    ivk_le: &[u8],
    epk_packed: &[u8],
    ciphertext: &[u8],
) -> Result<Option<Vec<u8>>, JsValue> {
    if ivk_le.len() != FIELD_BYTES {
        return Err(JsValue::from_str("ivk must be 32 bytes"));
    }
    if epk_packed.len() != FIELD_BYTES {
        return Err(JsValue::from_str("epk must be 32 bytes"));
    }

    // Small-subgroup guard, ~40% of this function's cost.
    //
    // Baby-Jubjub is Z_8 x Z_n, so a sender may pick `epk = T + [t]B` with `T`
    // in the 8-torsion and `t` of their choosing. Then
    // `shared = [ivk]T + [t]pk_d`, where `[t]pk_d` follows from the recipient's
    // public address and `[ivk]T` has at most 8 values. Eight crafted notes,
    // one of which decrypts, therefore reveal `ivk mod 8`.
    //
    // Three properties this relies on: the check is the full order-n test
    // (`[8]epk == O` admits the attack, since `[8]epk = [8t]B != O`); it runs
    // before any secret-dependent computation (deferring past Poly1305 lets the
    // crafted note verify and leaves the extra work observable as timing); and
    // a failure is treated as not-for-me.
    let mut epk_arr = [0u8; FIELD_BYTES];
    epk_arr.copy_from_slice(epk_packed);
    let epk = match decode_subgroup_point(&epk_arr) {
        Some(p) => p,
        None => return Ok(None),
    };

    let shared = epk.mul_scalar(&scalar_from_le(ivk_le));
    let shared_packed = Zeroizing::new(shared.compress());
    let key = Zeroizing::new(blake2b_32(&[KDF_DOMAIN, epk_packed, &*shared_packed]));

    let cipher = ChaCha20Poly1305::new(Key::from_slice(&*key));
    let nonce = Nonce::from(blake2b_12(&[NONCE_DOMAIN, epk_packed]));
    Ok(cipher.decrypt(&nonce, ciphertext).ok())
}
