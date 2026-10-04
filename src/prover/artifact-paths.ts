// Locating prover artifacts: which files a shape needs, and where they are.
//
// Resolution only; `artifact-bytes.ts` loads the content. `connect()` resolves
// eagerly so a misconfigured path throws at connect time, while the download is
// deferred to the prover build.
//
// Backend-agnostic: does not import snarkjs.

import { toAbsoluteUrl, urlToString } from "../core/url.js";
import { ProverArtifactsMissingError } from "../errors/prover.js";
import { getLogger } from "../log/logger.js";
import { type CircuitShape, DEFAULT_SHAPE, shapeId } from "../protocol/shape.js";
import { detectRuntime, IS_NODE, NODE_FS_PROMISES } from "../runtime/detect.js";
import { PROVER_ARTIFACT_SHA256 } from "./artifact-digests.js";
import type { ProverArtifacts, ProverPaths } from "./types.js";

export type { ProverArtifacts } from "./types.js";

/**
 * Companion package holding the proving artifacts. Published to GitHub Packages
 * (not public npm), so jsDelivr cannot proxy it and there is no built-in browser
 * CDN default.
 */
const COMPANION_PKG = "@lelantos-org/circuits";

const log = getLogger("lelantos:prover:artifacts");

/**
 * Resolve `ProverArtifacts` to absolute path strings.
 *
 * @internal
 */
export function resolveArtifacts(input: ProverArtifacts): ProverPaths {
    // Canonicalised here as well as in `loadArtifactBytes`: `WorkerProver`
    // posts this output to its worker, where `location.href` is the worker
    // script URL, so a relative path would resolve against a different base.
    return {
        wasmPath: toAbsoluteUrl(urlToString(input.circuit)),
        zkeyPath: toAbsoluteUrl(urlToString(input.zkey)),
        ...(input.sha256 ? { sha256: input.sha256 } : {}),
    };
}

/**
 * Resolve default Groth16 prover artifacts for `shape`.
 *
 * Artifacts are named after the shape (`4x6.wasm` / `4x6_final.zkey`).
 * Resolution order:
 *   1. `LELANTOS_PROVER_ARTIFACTS_DIR` env var (Node) — must contain the
 *      pair for the shape in use.
 *   2. Companion `@lelantos-org/circuits` npm package (Node) — via
 *      `import.meta.resolve`.
 *   3. `opts.cdn` URL (any runtime); the only source in a browser.
 *
 * Throws `ProverArtifactsMissingError` listing every source tried. A shape the
 * companion has no proving key for fails here rather than at proof time.
 *
 * Sources 2 and 3 are expected to hold the published release, so their
 * artifacts carry its digests (`artifact-digests.ts`) and are refused on a
 * mismatch. Source 1 is an operator's own directory, typically a local circuits
 * build with its own keys, and is taken as-is; so is an explicit
 * `prover.artifacts` unless it names `sha256` itself.
 *
 * @internal
 */
export async function bundledProverArtifacts(
    opts: {
        runtime?: "node" | "browser" | undefined;
        cdn?: string | undefined;
        shape?: CircuitShape | undefined;
    } = {},
): Promise<ProverArtifacts> {
    const runtime = opts.runtime ?? detectRuntime();
    const id = shapeId(opts.shape ?? DEFAULT_SHAPE);
    const tried: string[] = [];

    let companionCause: unknown;

    if (runtime === "node") {
        const envDir =
            typeof process !== "undefined" ? process.env.LELANTOS_PROVER_ARTIFACTS_DIR : undefined;
        if (envDir) {
            const base = envDir.replace(/\/$/, "");
            const pair = { circuit: `${base}/${id}.wasm`, zkey: `${base}/${id}_final.zkey` };
            // Probed so a wrong directory raises `ProverArtifactsMissingError`
            // here rather than `ENOENT` at proof time.
            if (await bothExist(pair)) return pair;
            tried.push(`env LELANTOS_PROVER_ARTIFACTS_DIR=${envDir} (files not found)`);
        }
        const companion = await tryResolveCompanion(id);
        if (companion.found) return pinned(companion.artifacts, id);
        companionCause = companion.cause;
        tried.push(`npm package ${COMPANION_PKG} (subpath ./${id}/${id}_final.zkey)`);
    }

    // Not `else if`: a CDN is a valid source on Node too, since
    // `loadArtifactBytes` treats only non-URLs as filesystem paths.
    if (opts.cdn) {
        const base = opts.cdn.replace(/\/$/, "");
        return pinned({ circuit: `${base}/${id}.wasm`, zkey: `${base}/${id}_final.zkey` }, id);
    }
    tried.push(
        runtime === "browser"
            ? "`prover.cdn` (not set; a browser needs it or `prover.artifacts`)"
            : "`prover.cdn` (not set)",
    );

    // The companion's failure is attached so an installed-but-broken package
    // (missing export subpath, wrong version) is distinguishable from an
    // absent one.
    throw new ProverArtifactsMissingError(tried, id, { cause: companionCause });
}

/** `artifacts` with the published release's digests for shape `id`, when it has any. */
function pinned(artifacts: ProverArtifacts, id: string): ProverArtifacts {
    const sha256 = PROVER_ARTIFACT_SHA256[id];
    return sha256 ? { ...artifacts, sha256 } : artifacts;
}

/** Outcome of probing the companion package. */
type CompanionProbe =
    | { readonly found: true; readonly artifacts: ProverArtifacts }
    | { readonly found: false; readonly cause?: unknown };

/** Resolve the companion package's artifacts. Never throws. */
async function tryResolveCompanion(id: string): Promise<CompanionProbe> {
    // `import.meta.resolve` is sync; it throws for a missing companion.
    try {
        const wasm = (import.meta as { resolve?: (s: string) => string }).resolve?.(
            `${COMPANION_PKG}/${id}/${id}.wasm`,
        );
        const zkey = (import.meta as { resolve?: (s: string) => string }).resolve?.(
            `${COMPANION_PKG}/${id}/${id}_final.zkey`,
        );
        if (!wasm || !zkey) return { found: false };
        return { found: true, artifacts: { circuit: new URL(wasm), zkey: new URL(zkey) } };
    } catch (cause) {
        log.debug("companion artifact package did not resolve", { id, cause });
        return { found: false, cause };
    }
}

/** Both artifact paths present on disk. Node only; anything else is a URL. */
async function bothExist(pair: { circuit: string; zkey: string }): Promise<boolean> {
    if (!IS_NODE) return true;
    try {
        const { access } = await import(/* @vite-ignore */ NODE_FS_PROMISES);
        await Promise.all([access(pair.circuit), access(pair.zkey)]);
        return true;
    } catch {
        return false;
    }
}
