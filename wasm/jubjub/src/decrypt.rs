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

use crate::common::{
    blake2b_12, blake2b_32, cofactor_scalar_from_le, decode_cleared_point, FIELD_BYTES,
};

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

    // Cofactor cleared, not checked. A sender may pick `epk = T + [t]B8` with
    // `T` in the 8-torsion; under a plain `[ivk]epk` that gives
    // `shared = [ivk]T + [t]pk_d`, whose second term follows from the published
    // address and whose first has only eight values — eight crafted notes, one
    // of which decrypts, would reveal `ivk mod 8`.
    //
    // `decode_cleared_point` and `cofactor_scalar_from_le` are a pair: together
    // they compute `[ivk]q` for the prime-order part of `epk`, which is
    // `[ivk]epk` for an honest point and carries no torsion term otherwise.
    let mut epk_arr = [0u8; FIELD_BYTES];
    epk_arr.copy_from_slice(epk_packed);
    let cleared = match decode_cleared_point(&epk_arr) {
        Some(p) => p,
        None => return Ok(None),
    };

    let shared = cleared.mul_scalar(&cofactor_scalar_from_le(ivk_le));
    let shared_packed = Zeroizing::new(shared.compress());
    let key = Zeroizing::new(blake2b_32(&[KDF_DOMAIN, epk_packed, &*shared_packed]));

    let cipher = ChaCha20Poly1305::new(Key::from_slice(&*key));
    let nonce = Nonce::from(blake2b_12(&[NONCE_DOMAIN, epk_packed]));
    Ok(cipher.decrypt(&nonce, ciphertext).ok())
}
