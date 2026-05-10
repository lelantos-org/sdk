// snarkjs Groth16 wrapper. Paths are placeholders — set them via
// `configureProver({ wasmPath, zkeyPath })` at app boot, or pass them
// per-call. Build artifacts live under `circuits/build/` after the
// trusted-setup ceremony output is materialised.

import * as snarkjs from "snarkjs";
import type { ProverArtifacts } from "./types.js";
import { urlToString } from "./types.js";
import { ProverArtifactsMissingError } from "./wallet/errors.js";

/// Companion-package name. SDK does not depend on it directly (would
/// pull a 44 MB zkey into every install); integrators add it explicitly
/// when they want zero-config Node prover artifacts.
///
/// Published to GitHub Packages, NOT public npm — jsDelivr cannot proxy
/// it, so there is no built-in browser CDN default. Browser callers
/// either pass `proverArtifacts` explicitly (most bundlers can resolve
/// the subpath imports against `node_modules`) or pass a self-hosted
/// `proverArtifactsCdn` URL.
const COMPANION_PKG = "@lelantos-org/circuits";

/// @deprecated Use `ProverArtifacts` from `./types`. Kept for back-compat.
export interface ProverPaths {
    wasmPath: string; // e.g. "circuits/build/2x2_js/2x2.wasm"
    zkeyPath: string; // e.g. "circuits/build/2x2_final.zkey"
}

/// Coerce either shape (legacy `ProverPaths` or new `ProverArtifacts`) to
/// the snarkjs-friendly path strings used internally.
export function resolveArtifacts(input: ProverPaths | ProverArtifacts): {
    wasmPath: string;
    zkeyPath: string;
} {
    if ("wasmPath" in input) return input;
    return { wasmPath: urlToString(input.circuit), zkeyPath: urlToString(input.zkey) };
}

let DEFAULT_PATHS: ProverPaths | null = null;

export function configureProver(paths: ProverPaths | ProverArtifacts): void {
    DEFAULT_PATHS = resolveArtifacts(paths);
}

export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: "groth16";
    curve: "bn128";
}

export interface ProveResult {
    proof: Groth16Proof;
    publicSignals: string[];
}

export async function prove(
    input: Record<string, unknown>,
    paths: ProverPaths | null = DEFAULT_PATHS,
): Promise<ProveResult> {
    if (!paths) throw new Error("prover paths not configured (call configureProver)");
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        input,
        paths.wasmPath,
        paths.zkeyPath,
    );
    return { proof, publicSignals };
}

export async function verify(
    vkey: object,
    publicSignals: string[],
    proof: Groth16Proof,
): Promise<boolean> {
    return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

/// Resolve default Groth16 prover artifacts for the canonical 2x2
/// circuit. Resolution order:
///
///   1. `LELANTOS_PROVER_ARTIFACTS_DIR` env var (Node) — directory must
///      contain `2x2.wasm` + `2x2_final.zkey`.
///   2. Companion `@lelantos-org/circuits` npm package (Node) — picked
///      up via `import.meta.resolve` if installed.
///   3. Explicit `opts.cdn` URL (browser) — caller's self-hosted base
///      URL serving `2x2.wasm` + `2x2_final.zkey`. There is NO built-in
///      browser default because the companion lives on GitHub Packages,
///      which jsDelivr cannot proxy.
///
/// Throws `ProverArtifactsMissingError` listing every path tried so
/// callers see a single actionable error instead of a chain of opaque
/// fetch failures at proof time.
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
    // `import.meta.resolve` is sync in Node ≥ 20.6. Wrap in try/catch
    // so a missing companion package returns null cleanly instead of
    // throwing through the resolver.
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

// Solidity calldata formatter for the on-chain Verifier.sol.
export async function exportSolidityCallData(
    proof: Groth16Proof,
    publicSignals: string[],
): Promise<string> {
    return snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
}
