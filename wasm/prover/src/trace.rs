//! Per-phase timing for the `trace` feature. Compiles to nothing without it.
//!
//! Groth16 proving splits into two blocks that matter: the QAP witness map and
//! the MSMs. `create_proof_with_reduction_and_matrices` runs both and reports
//! neither, so the only way to separate them is to run the witness map once on
//! its own and subtract it from the whole. A trace build therefore computes the
//! map **twice** and is slower than a release build — the output is a ratio for
//! deciding where to optimise, not a wall-clock figure to quote.

use ark_bn254::Fr;
use ark_relations::r1cs::ConstraintMatrices;
use wasm_bindgen::prelude::*;

#[cfg(feature = "trace")]
mod imp {
    use super::*;

    use ark_groth16::r1cs_to_qap::R1CSToQAP;
    use ark_poly::GeneralEvaluationDomain;

    use crate::qap::CircomReduction;

    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = console, js_name = log)]
        fn console_log(s: &str);
        #[wasm_bindgen(js_namespace = performance, js_name = now)]
        fn perf_now() -> f64;
    }

    /// An in-flight measurement. `finish` logs; dropping it reports nothing.
    pub struct ProveTrace {
        witness_map_ms: f64,
        groth16_start: f64,
    }

    impl ProveTrace {
        /// Time the witness map on its own, then start the clock on the proof.
        pub fn start(matrices: &ConstraintMatrices<Fr>, witness: &[Fr]) -> Result<Self, JsValue> {
            let t0 = perf_now();
            CircomReduction::witness_map_from_matrices::<Fr, GeneralEvaluationDomain<Fr>>(
                matrices,
                matrices.num_instance_variables,
                matrices.num_constraints,
                witness,
            )
            .map_err(crate::jserr)?;
            let groth16_start = perf_now();
            Ok(Self {
                witness_map_ms: groth16_start - t0,
                groth16_start,
            })
        }

        /// Log the split. `groth16` is the proof call alone; the map it runs
        /// internally is assumed to cost what the standalone one did, so
        /// `msm_block` is the remainder.
        pub fn finish(self) {
            let groth16 = perf_now() - self.groth16_start;
            let msm_block = groth16 - self.witness_map_ms;
            // Run-to-run noise can push the two measurements of the same map
            // apart far enough to invert the subtraction on a fast circuit.
            let share = if groth16 > 0.0 {
                format!("{:.0}% of groth16", 100.0 * msm_block / groth16)
            } else {
                "share unavailable".to_owned()
            };
            console_log(&format!(
                "[prover-trace] witness_map={:.1}ms groth16={groth16:.1}ms \
                 msm_block={msm_block:.1}ms ({share})",
                self.witness_map_ms,
            ));
        }
    }
}

#[cfg(not(feature = "trace"))]
mod imp {
    use super::*;

    /// Zero-sized stand-in so `prove` carries no `#[cfg]` of its own.
    pub struct ProveTrace;

    impl ProveTrace {
        #[inline(always)]
        pub fn start(_: &ConstraintMatrices<Fr>, _: &[Fr]) -> Result<Self, JsValue> {
            Ok(Self)
        }

        #[inline(always)]
        pub fn finish(self) {}
    }
}

pub(crate) use imp::ProveTrace;
