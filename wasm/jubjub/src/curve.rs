//! Vendored minimal Baby Jubjub Edwards arithmetic.
//!
//! Adapted from `babyjubjub-rs` v0.0.11 (Apache-2.0, arnaucube). Strips the
//! EdDSA / Schnorr / Poseidon paths so we don't pull `blake-hash`, `blake`,
//! `poseidon-rs`, `arrayref`, `generic-array`, `lazy_static`, or `rand`.
//!
//! Public surface kept: `Point`, `PointProjective`, `decompress_point`,
//! `compress`, `mul_scalar`, `add`, plus modular helpers.

use ff::*;
use num_bigint::{BigInt, Sign};
use num_traits::One;
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

fn d_big() -> &'static BigInt {
    static V: OnceLock<BigInt> = OnceLock::new();
    V.get_or_init(|| BigInt::parse_bytes(b"168696", 10).unwrap())
}

fn a_big() -> &'static BigInt {
    static V: OnceLock<BigInt> = OnceLock::new();
    V.get_or_init(|| BigInt::parse_bytes(b"168700", 10).unwrap())
}

pub fn q() -> &'static BigInt {
    static V: OnceLock<BigInt> = OnceLock::new();
    V.get_or_init(|| {
        BigInt::parse_bytes(
            b"21888242871839275222246405745257275088548364400416034343698204186575808495617",
            10,
        )
        .unwrap()
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
            return Point { x: fr_zero(), y: fr_zero() };
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
        PointProjective { x: x3, y: y3, z: z3 }
    }
}

#[derive(Clone, Debug)]
pub struct Point {
    pub x: Fr,
    pub y: Fr,
}

impl Point {
    pub fn projective(&self) -> PointProjective {
        PointProjective { x: self.x, y: self.y, z: fr_one() }
    }

    pub fn mul_scalar(&self, n: &BigInt) -> Point {
        let one = fr_one();
        let mut r = PointProjective { x: fr_zero(), y: one, z: one };
        let mut exp = self.projective();
        let (_, b) = n.to_bytes_le();
        for i in 0..n.bits() {
            if test_bit(&b, i as usize) {
                r = r.add(&exp);
            }
            exp = exp.add(&exp);
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

pub fn decompress_point(bb: [u8; 32]) -> Result<Point, String> {
    let mut sign = false;
    let mut b = bb;
    if b[31] & 0x80 != 0 {
        sign = true;
        b[31] &= 0x7f;
    }
    let y = BigInt::from_bytes_le(Sign::Plus, &b);
    if y >= *q() {
        return Err("y outside Fq".into());
    }
    let one: BigInt = One::one();
    // x^2 = (1 - y^2) / (a - d * y^2) (mod q)
    let den = modinv(
        &modulus(&(a_big() - modulus(&(d_big() * (&y * &y)), q())), q()),
        q(),
    )?;
    let mut x = modulus(&((one - modulus(&(&y * &y), q())) * den), q());
    x = modsqrt(&x, q())?;
    if sign && x <= (q().clone() >> 1) || (!sign && x > (q().clone() >> 1)) {
        x = -x;
    }
    x = modulus(&x, q());
    let x_fr = Fr::from_str(&x.to_string()).ok_or("Fr parse x")?;
    let y_fr = Fr::from_str(&y.to_string()).ok_or("Fr parse y")?;
    Ok(Point { x: x_fr, y: y_fr })
}

// ---------- helpers ----------

fn test_bit(b: &[u8], i: usize) -> bool {
    b[i / 8] & (1 << (i % 8)) != 0
}

fn modulus(a: &BigInt, m: &BigInt) -> BigInt {
    ((a % m) + m) % m
}

fn modinv(a: &BigInt, qq: &BigInt) -> Result<BigInt, String> {
    let zero: BigInt = num_traits::Zero::zero();
    if a == &zero { return Err("no mod inv of zero".into()); }
    let mut mn = (qq.clone(), a.clone());
    let mut xy: (BigInt, BigInt) = (zero.clone(), One::one());
    while mn.1 != zero {
        xy = (xy.1.clone(), xy.0 - (mn.0.clone() / mn.1.clone()) * xy.1);
        mn = (mn.1.clone(), modulus(&mn.0, &mn.1));
    }
    while xy.0 < zero { xy.0 = modulus(&xy.0, qq); }
    Ok(xy.0)
}

#[allow(clippy::many_single_char_names)]
fn modsqrt(a: &BigInt, qq: &BigInt) -> Result<BigInt, String> {
    let zero: BigInt = num_traits::Zero::zero();
    let one: BigInt = One::one();
    let two: BigInt = BigInt::from(2);
    if legendre_symbol(a, qq) != 1 || a == &zero || qq == &two {
        return Err("not a mod p square".into());
    }
    if qq % BigInt::from(4) == BigInt::from(3) {
        return Ok(a.modpow(&((qq + &one) / BigInt::from(4)), qq));
    }
    let mut s = qq - &one;
    let mut e: BigInt = zero.clone();
    while &s % &two == zero { s >>= 1; e += &one; }
    let mut n: BigInt = two.clone();
    while legendre_symbol(&n, qq) != -1 { n += &one; }
    let mut y = a.modpow(&((&s + &one) >> 1), qq);
    let mut b = a.modpow(&s, qq);
    let mut g = n.modpow(&s, qq);
    let mut r = e;
    loop {
        let mut t = b.clone();
        let mut m: BigInt = zero.clone();
        while t != one {
            t = modulus(&(&t * &t), qq);
            m += &one;
        }
        if m == zero { return Ok(y); }
        t = g.modpow(&two.modpow(&(&r - &m - &one), qq), qq);
        g = g.modpow(&two.modpow(&(r - &m), qq), qq);
        y = modulus(&(y * t), qq);
        b = modulus(&(b * &g), qq);
        r = m;
    }
}

fn legendre_symbol(a: &BigInt, qq: &BigInt) -> i32 {
    let one: BigInt = One::one();
    let ls = a.modpow(&((qq - &one) >> 1), qq);
    if ls == qq - one { -1 } else { 1 }
}
