//! Vendored minimal Baby Jubjub Edwards arithmetic.
//!
//! Adapted from `babyjubjub-rs` v0.0.11 (Apache-2.0, arnaucube). The EdDSA,
//! Schnorr and Poseidon paths are omitted, which drops the `blake-hash`,
//! `blake`, `poseidon-rs`, `arrayref`, `generic-array`, `lazy_static` and
//! `rand` dependencies.
//!
//! Public surface: `Point`, `PointProjective`, `decompress_point`, `compress`,
//! `mul_scalar`, `add`, `double`.
//!
//! `decompress_point` and `mul_scalar` run once per note during a wallet sync
//! and dominate its cost; both are tuned for that and diverge from upstream.
//! See their doc comments.

#![allow(clippy::too_many_arguments)]

use ff::*;
use num_bigint::BigInt;
use std::sync::OnceLock;

#[derive(PrimeField)]
#[PrimeFieldModulus = "21888242871839275222246405745257275088548364400416034343698204186575808495617"]
#[PrimeFieldGenerator = "7"]
pub struct Fr(FrRepr);

// Cached singletons. `Fr::from_str` allocates + parses decimal — avoid in
// hot paths (`PointProjective::add` calls `d`/`a_coeff` per iteration of
// scalar mul; `is_identity` uses 0/1 per check).
fn d() -> Fr {
    static V: OnceLock<Fr> = OnceLock::new();
    *V.get_or_init(|| Fr::from_str("168696").unwrap())
}
fn a_coeff() -> Fr {
    static V: OnceLock<Fr> = OnceLock::new();
    *V.get_or_init(|| Fr::from_str("168700").unwrap())
}
pub fn fr_zero() -> Fr {
    static V: OnceLock<Fr> = OnceLock::new();
    *V.get_or_init(Fr::zero)
}
pub fn fr_one() -> Fr {
    static V: OnceLock<Fr> = OnceLock::new();
    *V.get_or_init(Fr::one)
}

// (q - 1) / 2 as FrRepr — used by `compress` for x sign bit. Cached.
fn q_half_repr() -> &'static FrRepr {
    static V: OnceLock<FrRepr> = OnceLock::new();
    V.get_or_init(|| {
        let mut r = Fr::char();
        r.div2();
        r
    })
}

#[derive(Clone, Debug)]
pub struct PointProjective {
    pub x: Fr,
    pub y: Fr,
    pub z: Fr,
}

impl PointProjective {
    pub fn affine(&self) -> Point {
        if self.z.is_zero() {
            return Point {
                x: fr_zero(),
                y: fr_zero(),
            };
        }
        let zinv = self.z.inverse().unwrap();
        let mut x = self.x;
        x.mul_assign(&zinv);
        let mut y = self.y;
        y.mul_assign(&zinv);
        Point { x, y }
    }

    // add-2008-bbjlp https://hyperelliptic.org/EFD/g1p/auto-twisted-projective.html#addition-add-2008-bbjlp
    #[allow(clippy::many_single_char_names)]
    pub fn add(&self, qp: &PointProjective) -> PointProjective {
        let mut a = self.z;
        a.mul_assign(&qp.z);
        let mut b = a;
        b.square();
        let mut c = self.x;
        c.mul_assign(&qp.x);
        let mut dd = self.y;
        dd.mul_assign(&qp.y);
        let mut e = d();
        e.mul_assign(&c);
        e.mul_assign(&dd);
        let mut f = b;
        f.sub_assign(&e);
        let mut g = b;
        g.add_assign(&e);
        let mut x1y1 = self.x;
        x1y1.add_assign(&self.y);
        let mut x2y2 = qp.x;
        x2y2.add_assign(&qp.y);
        let mut aux = x1y1;
        aux.mul_assign(&x2y2);
        aux.sub_assign(&c);
        aux.sub_assign(&dd);
        let mut x3 = a;
        x3.mul_assign(&f);
        x3.mul_assign(&aux);
        let mut ac = a_coeff();
        ac.mul_assign(&c);
        let mut dac = dd;
        dac.sub_assign(&ac);
        let mut y3 = a;
        y3.mul_assign(&g);
        y3.mul_assign(&dac);
        let mut z3 = f;
        z3.mul_assign(&g);
        PointProjective {
            x: x3,
            y: y3,
            z: z3,
        }
    }

    // dbl-2008-bbjlp https://hyperelliptic.org/EFD/g1p/auto-twisted-projective.html#doubling-dbl-2008-bbjlp
    //
    // 3M + 4S, against 10M + 1S for `add`. `mul_scalar` doubles once per bit
    // and adds only on set bits, so doublings are roughly two thirds of its
    // work. Guarded by `double_matches_add`, which covers the identity and a
    // low-order point.
    pub fn double(&self) -> PointProjective {
        let mut b = self.x;
        b.add_assign(&self.y);
        b.square();
        let mut c = self.x;
        c.square();
        let mut dd = self.y;
        dd.square();
        let mut e = a_coeff();
        e.mul_assign(&c);
        let mut f = e;
        f.add_assign(&dd);
        let mut h = self.z;
        h.square();
        let mut j = f;
        j.sub_assign(&h);
        j.sub_assign(&h);
        // X3 = (B - C - D) * J
        let mut x3 = b;
        x3.sub_assign(&c);
        x3.sub_assign(&dd);
        x3.mul_assign(&j);
        // Y3 = F * (E - D)
        let mut e_minus_d = e;
        e_minus_d.sub_assign(&dd);
        let mut y3 = f;
        y3.mul_assign(&e_minus_d);
        // Z3 = F * J
        let mut z3 = f;
        z3.mul_assign(&j);
        PointProjective {
            x: x3,
            y: y3,
            z: z3,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Point {
    pub x: Fr,
    pub y: Fr,
}

impl Point {
    pub fn projective(&self) -> PointProjective {
        PointProjective {
            x: self.x,
            y: self.y,
            z: fr_one(),
        }
    }

    pub fn mul_scalar(&self, n: &BigInt) -> Point {
        let one = fr_one();
        let mut r = PointProjective {
            x: fr_zero(),
            y: one,
            z: one,
        };
        let mut exp = self.projective();
        let (_, b) = n.to_bytes_le();
        for i in 0..n.bits() {
            if test_bit(&b, i as usize) {
                r = r.add(&exp);
            }
            exp = exp.double();
        }
        r.affine()
    }

    pub fn compress(&self) -> [u8; 32] {
        let mut r = [0u8; 32];
        // Direct FrRepr → 32B LE. circomlibjs `isNegative(x)` ≡ x > (q-1)/2;
        // compare FrRepr (Ord-derived) instead of going through BigInt.
        self.y
            .into_repr()
            .write_le(&mut r[..])
            .expect("write_le 32B");
        if self.x.into_repr() > *q_half_repr() {
            r[31] |= 0x80;
        }
        r
    }
}

/// Decompress a circomlibjs-packed point: 32B LE `y`, with the high bit of the
/// last byte set when `x` is "negative" (`x > (q-1)/2`).
///
/// Recovers `x` from `x² = (1 - y²) / (a - d·y²)`.
///
/// Every step stays in `Fr`, whose Montgomery `inverse()` and `sqrt()` take
/// their Tonelli-Shanks constants from the `PrimeField` derive. Performing the
/// same arithmetic over `num_bigint` costs roughly 8x, largely in re-deriving
/// those constants per call.
pub fn decompress_point(bb: [u8; 32]) -> Result<Point, String> {
    let mut b = bb;
    let x_is_negative = b[31] & 0x80 != 0;
    b[31] &= 0x7f;

    let mut y_repr = FrRepr::default();
    y_repr.read_le(&b[..]).map_err(|_| "y unreadable")?;
    // `from_repr` rejects anything >= the modulus, so this is the `y < q` check.
    let y = Fr::from_repr(y_repr).map_err(|_| "y outside Fq")?;

    let mut y2 = y;
    y2.square();
    let mut numerator = fr_one();
    numerator.sub_assign(&y2);
    let mut denominator = d();
    denominator.mul_assign(&y2);
    denominator.negate();
    denominator.add_assign(&a_coeff());
    let mut x2 = denominator.inverse().ok_or("zero denominator")?;
    x2.mul_assign(&numerator);

    // `Fr::sqrt` maps 0 to `Some(0)`, which would admit `(0, ±1)`: the identity
    // and the order-2 point. Both are rejected here. Pinned by
    // `identity_does_not_decompress`.
    if x2.is_zero() {
        return Err("not a mod p square".into());
    }
    let mut x = x2.sqrt().ok_or("not a mod p square")?;

    if (x.into_repr() > *q_half_repr()) != x_is_negative {
        x.negate();
    }
    Ok(Point { x, y })
}

// ---------- helpers ----------

fn test_bit(b: &[u8], i: usize) -> bool {
    b[i / 8] & (1 << (i % 8)) != 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{base8_point, sub_order};

    /// Deterministic full-width scalars, matching the sizes `mul_scalar`
    /// receives in practice.
    fn scalars() -> Vec<BigInt> {
        (1u32..=16)
            .map(|i| {
                let seed = BigInt::from(i) * BigInt::from(0x9e3779b97f4a7c15u64)
                    + BigInt::from(0xbf58476d1ce4e5b9u64);
                (&seed * &seed) % sub_order()
            })
            .collect()
    }

    /// The order-2 point: on the curve (a·0 + y² = 1 with y = -1) but outside
    /// the odd-order subgroup.
    fn order_two() -> Point {
        let mut y = fr_one();
        y.negate();
        Point { x: fr_zero(), y }
    }

    #[test]
    fn compress_decompress_round_trips() {
        for k in scalars() {
            let p = base8_point().mul_scalar(&k);
            let got = decompress_point(p.compress()).expect("decompress");
            assert_eq!(got.x, p.x, "x mismatch for k={k}");
            assert_eq!(got.y, p.y, "y mismatch for k={k}");
            // Compression must be canonical: same point, same bytes.
            assert_eq!(got.compress(), p.compress());
        }
    }

    #[test]
    fn round_trips_the_generator() {
        let g = base8_point();
        let got = decompress_point(g.compress()).unwrap();
        assert_eq!((got.x, got.y), (g.x, g.y));
    }

    /// The identity `(0, 1)` does not decompress, diverging from circomlibjs
    /// `unpackPoint`, which accepts it.
    ///
    /// This has no effect in practice: `ON_CURVE_IDENTITY` appears only as a
    /// placeholder for an unused pad-output `ephPub`, and a pad note is
    /// discarded either way — here by the decompress failure, otherwise by the
    /// AEAD tag. Asserted so that any change to it is deliberate.
    #[test]
    fn identity_does_not_decompress() {
        let id = Point {
            x: fr_zero(),
            y: fr_one(),
        };
        assert!(decompress_point(id.compress()).is_err());
    }

    #[test]
    fn decompress_rejects_y_outside_the_field() {
        // q - 1 is the largest valid y; q and above must be refused. Take the
        // modulus itself, low 255 bits (sign bit cleared by construction).
        let mut b = [0xffu8; 32];
        b[31] = 0x7f; // 2^255 - 1 > q
        assert!(decompress_point(b).is_err());
    }

    #[test]
    fn decompress_rejects_a_y_with_no_matching_x() {
        // Search for a y where (1-y²)/(a-d·y²) is a non-residue. Roughly half
        // of all y qualify, so this terminates immediately.
        let mut found = false;
        for i in 2u32..64 {
            let y = Fr::from_str(&i.to_string()).unwrap();
            let mut b = [0u8; 32];
            y.into_repr().write_le(&mut b[..]).unwrap();
            if decompress_point(b).is_err() {
                found = true;
                break;
            }
        }
        assert!(found, "expected some small y to be off-curve");
    }

    #[test]
    fn sign_bit_selects_the_correct_x() {
        // The two roots ±x differ only in the compressed sign bit, and each
        // must decompress back to its own root.
        for k in scalars().into_iter().take(4) {
            let p = base8_point().mul_scalar(&k);
            let mut neg = p.clone();
            neg.x.negate();
            assert_ne!(p.compress(), neg.compress(), "sign bit must differ");
            assert_eq!(decompress_point(neg.compress()).unwrap().x, neg.x);
            assert_eq!(decompress_point(p.compress()).unwrap().x, p.x);
        }
    }

    #[test]
    fn in_subgroup_accepts_multiples_of_the_generator() {
        for k in scalars() {
            assert!(crate::common::in_subgroup(&base8_point().mul_scalar(&k)));
        }
    }

    #[test]
    fn in_subgroup_rejects_a_low_order_point() {
        let t = order_two();
        // Sanity: it really is order 2 and really is on the curve.
        assert!(crate::common::is_identity(
            &t.mul_scalar(&BigInt::from(2u32))
        ));
        assert!(!crate::common::in_subgroup(&t));
    }

    #[test]
    fn double_matches_add() {
        // The dedicated doubling must agree with the generic addition on every
        // input, including the identity and a low-order point.
        let g = base8_point();
        let mut points: Vec<Point> = scalars().iter().map(|k| g.mul_scalar(k)).collect();
        points.push(Point {
            x: fr_zero(),
            y: fr_one(),
        });
        points.push(order_two());
        for p in points {
            let pp = p.projective();
            let via_add = pp.add(&pp).affine();
            let via_dbl = pp.double().affine();
            assert_eq!((via_dbl.x, via_dbl.y), (via_add.x, via_add.y));
        }
    }

    #[test]
    fn mul_scalar_is_additively_homomorphic() {
        // [j]B + [k]B == [j+k]B. Guards any rewrite of the scalar-mult loop.
        let g = base8_point();
        let ks = scalars();
        for w in ks.chunks(2).filter(|c| c.len() == 2) {
            let (j, k) = (&w[0], &w[1]);
            let lhs = g
                .mul_scalar(j)
                .projective()
                .add(&g.mul_scalar(k).projective());
            let rhs = g.mul_scalar(&((j + k) % sub_order()));
            let lhs = lhs.affine();
            assert_eq!((lhs.x, lhs.y), (rhs.x, rhs.y), "j={j} k={k}");
        }
    }
}
