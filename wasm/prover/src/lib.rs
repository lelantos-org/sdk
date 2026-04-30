//! Browser Groth16 prover façade. Reads snarkjs zkey + circom .wtns,
//! runs ark-groth16 (rayon-parallel when crossOriginIsolated).
//!
//! Public WASM API:
//!   init()                                  — wasm-pack default
//!   initThreadPool(n)                       — from wasm-bindgen-rayon (parallel feature)
//!   new ProverSession(zkeyU8)               — parses zkey once
//!   session.prove(wtnsU8) -> snarkjs Groth16Proof shape:
//!     { piA: [x,y,"1"], piB: [[x.c0,x.c1],[y.c0,y.c1],["1","0"]],
//!       piC: [x,y,"1"], publicSignals: [decimal strings] }

mod encode;
mod qap;
mod wtns;
mod zkey;

use std::io::Cursor;

use ark_bn254::{Bn254, Fr};
use ark_groth16::{Groth16, ProvingKey};
use ark_relations::r1cs::ConstraintMatrices;
use wasm_bindgen::prelude::*;

use crate::encode::{public_signals, ProveOutput};
use crate::qap::CircomReduction;
use crate::zkey::read_zkey;

#[cfg(feature = "parallel")]
pub use wasm_bindgen_rayon::init_thread_pool;

#[wasm_bindgen(start)]
pub fn _start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct ProverSession {
    pk: ProvingKey<Bn254>,
    matrices: ConstraintMatrices<Fr>,
}

#[wasm_bindgen]
impl ProverSession {
    #[wasm_bindgen(constructor)]
    pub fn new(zkey_bytes: &[u8]) -> Result<ProverSession, JsValue> {
        let mut cursor = Cursor::new(zkey_bytes);
        let (pk, matrices) = read_zkey(&mut cursor).map_err(jserr)?;
        Ok(ProverSession { pk, matrices })
    }

    pub fn prove(&self, wtns_bytes: &[u8]) -> Result<JsValue, JsValue> {
        let witness = wtns::parse_bn254(wtns_bytes).map_err(jserr)?;

        let n_public = self.matrices.num_instance_variables - 1;
        if witness.len() < 1 + n_public {
            return Err(JsValue::from_str("witness shorter than nPublic+1"));
        }

        let zero = Fr::from(0u64);
        let proof = Groth16::<Bn254, CircomReduction>::create_proof_with_reduction_and_matrices(
            &self.pk,
            zero,
            zero,
            &self.matrices,
            self.matrices.num_instance_variables,
            self.matrices.num_constraints,
            witness.as_slice(),
        )
        .map_err(jserr)?;

        let out = ProveOutput::from_proof(&proof, public_signals(&witness, n_public));
        serde_wasm_bindgen::to_value(&out).map_err(jserr)
    }
}

fn jserr<E: core::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}
