//! Baby-Jubjub WASM backend. Drop-in for circomlibjs `Jubjub`.
//!
//! Self-contained: vendored Edwards arithmetic in `curve.rs` (adapted from
//! `babyjubjub-rs`, MIT). No `blake-hash`, `poseidon-rs`, or signature
//! machinery — keeps wasm minimal.
//!
//! Wire conventions:
//!   field element  : 32 bytes little-endian
//!   point (in/out) : 64 bytes = x_LE (32) || y_LE (32)
//!   packed point   : 32 bytes = y_LE with high bit of byte 31 = sign(x).
//!                    Matches circomlibjs `babyJub.packPoint` exactly.

extern crate ff;
extern crate rand;

mod common;
mod curve;
mod decrypt;

use common::{in_subgroup, scalar_from_le, FIELD_BYTES};
use curve::{decompress_point, Fr, FrRepr, Point};
use ff::{PrimeField, PrimeFieldRepr};
use num_bigint::{BigInt, Sign};
use std::sync::OnceLock;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn _start() {
    console_error_panic_hook::set_once();
}

const POINT_BYTES: usize = 64;

// --------- field <-> bytes ---------
//
// Direct FrRepr round-trip; avoids BigInt + decimal-string conversion
// (previous path: bytes → BigInt → to_string → Fr::from_str ≈ ~10× slower).

fn fr_from_le(bytes: &[u8]) -> Result<Fr, JsValue> {
    if bytes.len() != FIELD_BYTES {
        return Err(JsValue::from_str("field element must be 32 bytes"));
    }
    let mut repr = FrRepr::default();
    repr.read_le(bytes)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    Fr::from_repr(repr).map_err(|e| JsValue::from_str(&e.to_string()))
}

fn fr_to_le(f: &Fr) -> [u8; FIELD_BYTES] {
    let mut out = [0u8; FIELD_BYTES];
    f.into_repr().write_le(&mut out[..]).expect("write_le 32B");
    out
}

// --------- point I/O ---------

fn point_from_uncompressed(bytes: &[u8]) -> Result<Point, JsValue> {
    if bytes.len() != POINT_BYTES {
        return Err(JsValue::from_str("point must be 64 bytes (x||y LE)"));
    }
    Ok(Point {
        x: fr_from_le(&bytes[..FIELD_BYTES])?,
        y: fr_from_le(&bytes[FIELD_BYTES..])?,
    })
}

fn point_to_uncompressed(p: &Point) -> [u8; POINT_BYTES] {
    let mut out = [0u8; POINT_BYTES];
    out[..FIELD_BYTES].copy_from_slice(&fr_to_le(&p.x));
    out[FIELD_BYTES..].copy_from_slice(&fr_to_le(&p.y));
    out
}

fn base8_point() -> &'static Point {
    static V: OnceLock<Point> = OnceLock::new();
    V.get_or_init(|| Point {
        x: Fr::from_str(
            "5299619240641551281634865583518297030282874472190772894086521144482721001553",
        )
        .unwrap(),
        y: Fr::from_str(
            "16950150798460657717958625567821834550301663161624707787222815936182638968203",
        )
        .unwrap(),
    })
}

pub(crate) fn sub_order() -> &'static BigInt {
    static V: OnceLock<BigInt> = OnceLock::new();
    V.get_or_init(|| {
        BigInt::parse_bytes(
            b"2736030358979909402780800718157159386076813972158567259200215660948447373041",
            10,
        )
        .unwrap()
    })
}

// --------- exported API ---------

#[wasm_bindgen]
pub fn base8() -> Vec<u8> {
    point_to_uncompressed(base8_point()).to_vec()
}

#[wasm_bindgen]
pub fn sub_order_le() -> Vec<u8> {
    let (_, mut le) = sub_order().to_bytes_le();
    le.resize(FIELD_BYTES, 0);
    le
}

#[wasm_bindgen]
pub fn add_point(a: &[u8], b: &[u8]) -> Result<Vec<u8>, JsValue> {
    let pa = point_from_uncompressed(a)?;
    let pb = point_from_uncompressed(b)?;
    let sum = pa.projective().add(&pb.projective()).affine();
    Ok(point_to_uncompressed(&sum).to_vec())
}

#[wasm_bindgen]
pub fn mul_point_escalar(p: &[u8], scalar_le: &[u8]) -> Result<Vec<u8>, JsValue> {
    let pt = point_from_uncompressed(p)?;
    let res = pt.mul_scalar(&scalar_from_le(scalar_le));
    Ok(point_to_uncompressed(&res).to_vec())
}

#[wasm_bindgen(js_name = in_subgroup)]
pub fn in_subgroup_js(p: &[u8]) -> Result<bool, JsValue> {
    let pt = point_from_uncompressed(p)?;
    Ok(in_subgroup(&pt))
}

#[wasm_bindgen]
pub fn pack_point(p: &[u8]) -> Result<Vec<u8>, JsValue> {
    let pt = point_from_uncompressed(p)?;
    Ok(pt.compress().to_vec())
}

// --------- HashToAssetGen: circomlibjs Pedersen-264, single-segment, 72-bit input ---------
//
// Mirrors circuits/src/lib/asset_gen.circom and circomlibjs `PedersenHash`:
//   input bits = TAG_ASSET (8 LSB-first) || asset_id (64 LSB-first), total 72
//   windowSize = 4 (3 data + 1 sign), 1 segment (< 200 bits)
//   base point = Pedersen base #0 with baseHash="blake" (circomlibjs default).
//
// `BASE0` is precomputed from circomlibjs to avoid pulling BLAKE-256 + the
// generator-derivation loop into the wasm binary. Parity is enforced by
// `jubjub-wasm.test.ts` fixtures.

const TAG_ASSET: u8 = 7;
const PEDERSEN_WINDOW_SIZE: usize = 4;
const PEDERSEN_INPUT_BITS: usize = 72;

fn pedersen_base0() -> &'static Point {
    static V: OnceLock<Point> = OnceLock::new();
    V.get_or_init(|| Point {
        x: Fr::from_str(
            "10457101036533406547632367118273992217979173478358440826365724437999023779287",
        )
        .unwrap(),
        y: Fr::from_str(
            "19824078218392094440610104313265183977899662750282163392862422243483260492317",
        )
        .unwrap(),
    })
}

#[wasm_bindgen]
pub fn hash_to_asset_gen(asset_id_le: &[u8]) -> Result<Vec<u8>, JsValue> {
    if asset_id_le.len() != 8 {
        return Err(JsValue::from_str("asset_id must be 8 bytes LE"));
    }

    let mut buf = [0u8; 9];
    buf[0] = TAG_ASSET;
    buf[1..9].copy_from_slice(asset_id_le);

    // LSB-first per byte, matching circomlibjs `buffer2bits`.
    let mut bits = [false; PEDERSEN_INPUT_BITS];
    for (i, byte) in buf.iter().enumerate() {
        for b in 0..8 {
            bits[i * 8 + b] = ((byte >> b) & 1) == 1;
        }
    }

    // Single segment (72 < 200 bits). nWindows = floor((72-1)/4) + 1 = 18.
    let n_windows = (PEDERSEN_INPUT_BITS - 1) / PEDERSEN_WINDOW_SIZE + 1;
    let mut escalar = BigInt::from(0);
    let mut exp = BigInt::from(1);

    for w in 0..n_windows {
        let o = w * PEDERSEN_WINDOW_SIZE;
        // First `windowSize - 1` bits = data, last bit = sign.
        let mut acc = BigInt::from(1);
        for b in 0..(PEDERSEN_WINDOW_SIZE - 1) {
            let pos = o + b;
            if pos < PEDERSEN_INPUT_BITS && bits[pos] {
                acc += BigInt::from(1) << b;
            }
        }
        let sign_pos = o + (PEDERSEN_WINDOW_SIZE - 1);
        if sign_pos < PEDERSEN_INPUT_BITS && bits[sign_pos] {
            acc = -acc;
        }
        escalar += &acc * &exp;
        exp <<= PEDERSEN_WINDOW_SIZE + 1; // 5
    }

    if escalar.sign() == Sign::Minus {
        escalar += sub_order();
    }

    // Convert reduced scalar to 32-byte LE then run the standard `mul_scalar`
    // path (matches `mul_point_escalar` semantics: reduce mod sub_order).
    let (_, mut le) = escalar.to_bytes_le();
    le.resize(FIELD_BYTES, 0);
    let scalar = scalar_from_le(&le);
    let res = pedersen_base0().mul_scalar(&scalar);
    Ok(point_to_uncompressed(&res).to_vec())
}

#[wasm_bindgen]
pub fn unpack_point(buf: &[u8]) -> Result<Option<Vec<u8>>, JsValue> {
    if buf.len() != FIELD_BYTES {
        return Err(JsValue::from_str("packed point must be 32 bytes"));
    }
    let mut arr = [0u8; FIELD_BYTES];
    arr.copy_from_slice(buf);
    match decompress_point(arr) {
        Ok(p) => Ok(Some(point_to_uncompressed(&p).to_vec())),
        Err(_) => Ok(None),
    }
}
