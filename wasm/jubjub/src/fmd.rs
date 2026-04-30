//! Fused FMD2 (Niwl) detection. Inlines γ scalar muls + γ blake2b shared-bit
//! derivations + clue-bit XOR into one wasm-bindgen entry. Cuts γ FFI hops
//! per note.
//!
//! Wire format must match `sdk/src/fmd.ts`:
//!   shared_i = R · x_i        (Baby Jubjub)
//!   bit_i    = lsb(blake2b("lelantos.fmd.v1" || R_packed || u32LE(i) || shared_i_packed))
//!   accept   ⇔ for all i: bit_i ⊕ c_i == 1

use wasm_bindgen::prelude::*;

use crate::common::{blake2b_32, decode_subgroup_point, scalar_from_le, FIELD_BYTES};

const FMD_DOMAIN: &[u8] = b"lelantos.fmd.v1";

/// `dk_le` is γ scalars concatenated, each 32B little-endian.
/// `clue_r` is the packed Baby-Jubjub point (32B).
/// `clue_bits` is the LSB-first packed bit array (⌈γ/8⌉ bytes).
#[wasm_bindgen]
pub fn fmd_test(
    dk_le: &[u8],
    clue_r: &[u8],
    clue_bits: &[u8],
    gamma: u8,
) -> Result<bool, JsValue> {
    let g = gamma as usize;
    if dk_le.len() != g * FIELD_BYTES {
        return Err(JsValue::from_str("dk length must equal gamma * 32"));
    }
    if clue_r.len() != FIELD_BYTES {
        return Err(JsValue::from_str("clue_r must be 32 bytes"));
    }
    if clue_bits.len() != (g + 7) / 8 {
        return Err(JsValue::from_str("clue_bits length must equal ceil(gamma/8)"));
    }

    let mut r_arr = [0u8; FIELD_BYTES];
    r_arr.copy_from_slice(clue_r);
    let r_point = match decode_subgroup_point(&r_arr) {
        Some(p) => p,
        None => return Ok(false),
    };

    for i in 0..g {
        let xi = scalar_from_le(&dk_le[i * FIELD_BYTES..(i + 1) * FIELD_BYTES]);
        let shared_packed = r_point.mul_scalar(&xi).compress();
        let bit = blake2b_32(&[FMD_DOMAIN, clue_r, &(i as u32).to_le_bytes(), &shared_packed])[0]
            & 1;
        let c_bit = (clue_bits[i >> 3] >> (i & 7)) & 1;
        if (bit ^ c_bit) != 1 {
            return Ok(false);
        }
    }
    Ok(true)
}
