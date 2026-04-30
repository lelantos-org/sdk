//! Fused trial-decrypt path. Inlines the per-note pipeline:
//!   decompress epk → subgroup check → ECDH (epk · ivk) → blake2b KDF
//!   → ChaCha20-Poly1305 decrypt
//! into one wasm-bindgen entry. Cuts four FFI hops to one and replaces
//! pure-JS @noble blake2b + chacha with RustCrypto's wasm32 impls.
//!
//! Wire format must match `sdk/src/note-encrypt.ts` byte-for-byte:
//!   key  = blake2b("lelantos.note.kdf.v1" || epk_packed || shared_packed, 32B)
//!   ct   = ChaCha20-Poly1305(key, nonce=0¹², plaintext)

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use wasm_bindgen::prelude::*;

use crate::common::{blake2b_32, decode_subgroup_point, scalar_from_le, FIELD_BYTES};

const KDF_DOMAIN: &[u8] = b"lelantos.note.kdf.v1";

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

    let mut epk_arr = [0u8; FIELD_BYTES];
    epk_arr.copy_from_slice(epk_packed);
    let epk = match decode_subgroup_point(&epk_arr) {
        Some(p) => p,
        None => return Ok(None),
    };

    let shared = epk.mul_scalar(&scalar_from_le(ivk_le));
    let shared_packed = shared.compress();
    let key = blake2b_32(&[KDF_DOMAIN, epk_packed, &shared_packed]);

    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
    let nonce = Nonce::from([0u8; 12]);
    Ok(cipher.decrypt(&nonce, ciphertext).ok())
}
