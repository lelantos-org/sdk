// snarkjs Groth16 wrapper. Configure via `configureProver({ wasmPath, zkeyPath })`
// at app boot or pass per-call. Artifacts live under `circuits/build/`.

import type * as SnarkjsT from "snarkjs";
import { urlToString } from "../utils/types.js";

let snarkjsMod: typeof SnarkjsT | null = null;
async function loadSnarkjs(): Promise<typeof SnarkjsT> {
    if (snarkjsMod) return snarkjsMod;
    try {
        snarkjsMod = (await import("snarkjs")) as typeof SnarkjsT;
        return snarkjsMod;
    } catch (e) {
        throw new Error(
            "snarkjs prover requested but `snarkjs` is not installed. " +
                "Add it to your app dependencies (`npm i snarkjs`), or use the WASM prover " +
                "(`@lelantos-org/sdk/wasm-prover`).",
            { cause: e as Error },
        );
    }
}

import { ProverArtifactsMissingError } from "../wallet/errors.js";
import type { ProverArtifacts } from "./artifacts.js";

/// Companion package — published to GitHub Packages (not public npm),
/// so jsDelivr cannot proxy it and there is no built-in browser CDN default.
/// Integrators add it explicitly to avoid pulling a 44 MB zkey into installs.
const COMPANION_PKG = "@lelantos-org/circuits";

/// @deprecated Use `ProverArtifacts` from `./artifacts`.
export interface ProverPaths {
    wasmPath: string; // e.g. "circuits/build/2x2_js/2x2.wasm"
    zkeyPath: string; // e.g. "circuits/build/2x2_final.zkey"
}

/** @internal */
/// Coerce `ProverPaths` or `ProverArtifacts` to snarkjs-friendly path strings.
export function resolveArtifacts(input: ProverPaths | ProverArtifacts): {
    wasmPath: string;
    zkeyPath: string;
} {
    if ("wasmPath" in input) return input;
    return { wasmPath: urlToString(input.circuit), zkeyPath: urlToString(input.zkey) };
}

let DEFAULT_PATHS: ProverPaths | null = null;

/** @internal */
export function configureProver(paths: ProverPaths | ProverArtifacts): void {
    DEFAULT_PATHS = resolveArtifacts(paths);
}

/** @internal */
export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: "groth16";
    curve: "bn128";
}

/** @internal */
export interface ProveResult {
    proof: Groth16Proof;
    publicSignals: string[];
}

/** @internal */
export async function prove(
    input: Record<string, unknown>,
    paths: ProverPaths | null = DEFAULT_PATHS,
): Promise<ProveResult> {
    if (!paths) throw new Error("prover paths not configured (call configureProver)");
    const snarkjs = await loadSnarkjs();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        input,
        paths.wasmPath,
        paths.zkeyPath,
    );
    return { proof, publicSignals };
}

/** @internal */
export async function verify(
    vkey: object,
    publicSignals: string[],
    proof: Groth16Proof,
): Promise<boolean> {
    const snarkjs = await loadSnarkjs();
    return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

/** @internal */
/// Resolve default Groth16 prover artifacts for the canonical 2x2 circuit.
/// Resolution order:
///   1. `LELANTOS_PROVER_ARTIFACTS_DIR` env var (Node) — must contain
///      `2x2.wasm` + `2x2_final.zkey`.
///   2. Companion `@lelantos-org/circuits` npm package (Node) — via
///      `import.meta.resolve`.
///   3. Explicit `opts.cdn` URL (browser). No built-in browser default
///      because the companion lives on GitHub Packages.
///
/// Throws `ProverArtifactsMissingError` listing every path tried.
export async function bundledProverArtifacts(
    opts: { runtime?: "node" | "browser"; cdn?: string } = {},
): Promise<ProverArtifacts> {
    const runtime = opts.runtime ?? detectRuntime();
    const tried: string[] = [];

    if (runtime === "node") {
        const envDir =
            typeof process !== "undefined" ? process.env.LELANTOS_PROVER_ARTIFACTS_DIR : undefined;
        if (envDir) {
            tried.push(`env LELANTOS_PROVER_ARTIFACTS_DIR=${envDir}`);
            return {
                circuit: `${envDir.replace(/\/$/, "")}/2x2.wasm`,
                zkey: `${envDir.replace(/\/$/, "")}/2x2_final.zkey`,
            };
        }
        const fromCompanion = await tryResolveCompanion();
        if (fromCompanion) return fromCompanion;
        tried.push(`npm package ${COMPANION_PKG}`);
    } else if (opts.cdn) {
        const base = opts.cdn.replace(/\/$/, "");
        return { circuit: `${base}/2x2.wasm`, zkey: `${base}/2x2_final.zkey` };
    } else {
        tried.push("opts.cdn (browser requires explicit `proverArtifactsCdn`)");
    }

    throw new ProverArtifactsMissingError(tried);
}

function detectRuntime(): "node" | "browser" {
    const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
    return isBrowser ? "browser" : "node";
}

async function tryResolveCompanion(): Promise<ProverArtifacts | null> {
    // `import.meta.resolve` sync in Node ≥ 20.6; try/catch so a missing
    // companion returns null cleanly.
    try {
        const wasm = (import.meta as { resolve?: (s: string) => string }).resolve?.(
            `${COMPANION_PKG}/2x2/2x2.wasm`,
        );
        const zkey = (import.meta as { resolve?: (s: string) => string }).resolve?.(
            `${COMPANION_PKG}/2x2/2x2_final.zkey`,
        );
        if (!wasm || !zkey) return null;
        return { circuit: new URL(wasm), zkey: new URL(zkey) };
    } catch {
        return null;
    }
}

/** @internal */
// Solidity calldata formatter for the on-chain Verifier.sol.
export async function exportSolidityCallData(
    proof: Groth16Proof,
    publicSignals: string[],
): Promise<string> {
    const snarkjs = await loadSnarkjs();
    return snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
}
