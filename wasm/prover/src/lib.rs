//! Browser Groth16 prover façade. Reads snarkjs zkey + circom .wtns,
//! runs `taceo-groth16` (rayon-parallel when crossOriginIsolated).
//!
//! Public WASM API:
//!   init()                                  — wasm-pack default
//!   initThreadPool(n)                       — from wasm-bindgen-rayon (parallel feature)
//!   new ProverSession(zkeyU8)               — parses zkey once
//!   session.prove(wtnsU8) -> snarkjs Groth16Proof shape:
//!     { piA: [x,y,"1"], piB: [[x.c0,x.c1],[y.c0,y.c1],["1","0"]],
//!       piC: [x,y,"1"], publicSignals: [decimal strings] }

mod encode;
mod trace;
mod wtns;
mod zkey;

use std::io::Cursor;

use ark_bn254::{Bn254, Fr};
use ark_groth16::ProvingKey;
use ark_std::UniformRand;
use rand_core::OsRng;
use taceo_groth16::{CircomReduction, ConstraintMatrices, Groth16};
use wasm_bindgen::prelude::*;

use crate::encode::{public_signals, ProveOutput};
use crate::trace::ProveTrace;
use crate::zkey::read_zkey;

#[cfg(feature = "parallel")]
pub use wasm_bindgen_rayon::init_thread_pool;

// `talc` in place of the default dlmalloc, for speed. The build always has
// `+atomics` (see `.cargo/config.toml`) and rayon workers share linear memory,
// hence the thread-safe `TalcLock` variant.
#[cfg(target_family = "wasm")]
#[global_allocator]
static TALC: talc::sync::TalcLock<
    spinning_top::RawSpinlock,
    talc::wasm::WasmGrowAndClaim,
    talc::wasm::WasmBinning,
> = talc::sync::TalcLock::new(talc::wasm::WasmGrowAndClaim);

#[wasm_bindgen(start)]
pub fn _start() {
    console_error_panic_hook::set_once();
}

/// Number of threads rayon reports on the calling thread.
///
/// The MSM and the FFT divide their work by this number, not by the worker
/// count given to `initThreadPool`: if it reads 1, proving runs serially
/// whatever the pool size. The value depends on the calling context, so call
/// it from the context that calls `prove`.
#[wasm_bindgen(js_name = threadCount)]
pub fn thread_count() -> usize {
    #[cfg(feature = "parallel")]
    {
        rayon::current_num_threads()
    }
    #[cfg(not(feature = "parallel"))]
    {
        1
    }
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

        // A no-op without the `trace` feature.
        let trace = ProveTrace::start(&self.matrices, witness.as_slice())?;

        let r = Fr::rand(&mut OsRng);
        let s = Fr::rand(&mut OsRng);
        let proof = Groth16::<Bn254>::prove::<CircomReduction>(
            &self.pk,
            r,
            s,
            &self.matrices,
            witness.as_slice(),
        )
        .map_err(jserr)?;

        trace.finish();

        let out = ProveOutput::from_proof(&proof, public_signals(&witness, n_public));
        serde_wasm_bindgen::to_value(&out).map_err(jserr)
    }
}

pub(crate) fn jserr<E: core::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}
