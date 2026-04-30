//! ark Groth16 proof + witness → snarkjs `Groth16Proof` JSON shape (decimal
//! strings). Coefficient order in `Fq2` (`c0 + c1·u`) matches circom/snarkjs.

use ark_bn254::{Bn254, Fq, Fq2, Fr, G1Affine, G2Affine};
use ark_ff::PrimeField;
use ark_groth16::Proof;
use serde::Serialize;

#[derive(Serialize)]
pub struct ProveOutput {
    #[serde(rename = "piA")]
    pi_a: [String; 3],
    #[serde(rename = "piB")]
    pi_b: [[String; 2]; 3],
    #[serde(rename = "piC")]
    pi_c: [String; 3],
    #[serde(rename = "publicSignals")]
    public_signals: Vec<String>,
}

impl ProveOutput {
    pub fn from_proof(proof: &Proof<Bn254>, public_signals: Vec<String>) -> Self {
        Self {
            pi_a: g1(&proof.a),
            pi_b: g2(&proof.b),
            pi_c: g1(&proof.c),
            public_signals,
        }
    }
}

pub fn public_signals(witness: &[Fr], n_public: usize) -> Vec<String> {
    witness.iter().skip(1).take(n_public).map(fr).collect()
}

fn fr(f: &Fr) -> String { f.into_bigint().to_string() }
fn fq(f: &Fq) -> String { f.into_bigint().to_string() }
fn fq2(f: &Fq2) -> [String; 2] { [fq(&f.c0), fq(&f.c1)] }

// G1 = [x, y, "1"] (Jacobian Z=1).
fn g1(p: &G1Affine) -> [String; 3] {
    [fq(&p.x), fq(&p.y), "1".to_string()]
}

// G2 = [[x.c0, x.c1], [y.c0, y.c1], ["1", "0"]].
fn g2(p: &G2Affine) -> [[String; 2]; 3] {
    [fq2(&p.x), fq2(&p.y), ["1".to_string(), "0".to_string()]]
}
