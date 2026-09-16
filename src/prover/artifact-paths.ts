// Locating prover artifacts: which files a shape needs, and where they are.
//
// Resolution only; `artifact-bytes.ts` loads the content. `connect()` resolves
// eagerly so a misconfigured path throws at connect time, while the ~52 MB
// download is deferred to the prover build.
//
// Backend-agnostic: does not import snarkjs.

import { toAbsoluteUrl, urlToString } from "../core/url.js";
import { ProverArtifactsMissingError } from "../errors/prover.js";
import { getLogger } from "../log/logger.js";
import { type CircuitShape, DEFAULT_SHAPE, shapeId } from "../protocol/shape.js";
import { detectRuntime, IS_NODE, NODE_FS_PROMISES } from "../runtime/detect.js";
import type { ProverArtifacts, ProverPaths } from "./types.js";

export type { ProverArtifacts } from "./types.js";

/**
 * Companion package, published to GitHub Packages (not public npm), so jsDelivr
 * cannot proxy it and there is no built-in browser CDN default. It is an
 * explicit dependency to keep ~50 MB of proving artifacts out of every install.
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
    };
}

/**
 * Resolve default Groth16 prover artifacts for `shape`.
 *
 * Artifacts are named after the shape (`4x6.wasm` / `4x6_final.zkey`), matching the
 * circuits package. Resolution order:
 *   1. `LELANTOS_PROVER_ARTIFACTS_DIR` env var (Node) — must contain the
 *      pair for the shape in use.
 *   2. Companion `@lelantos-org/circuits` npm package (Node) — via
 *      `import.meta.resolve`.
 *   3. Explicit `opts.cdn` URL (browser). No built-in browser default
 *      because the companion lives on GitHub Packages.
 *
 * Throws `ProverArtifactsMissingError` listing every path tried. A shape the
 * companion has no proving key for fails here rather than at proof time.
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
        if (companion.found) return companion.artifacts;
        companionCause = companion.cause;
        tried.push(`npm package ${COMPANION_PKG} (subpath ./${id}/${id}_final.zkey)`);
    }

    // Not `else if`: a CDN is a valid source on Node too, since
    // `loadArtifactBytes` treats only non-URLs as filesystem paths.
    if (opts.cdn) {
        const base = opts.cdn.replace(/\/$/, "");
        return { circuit: `${base}/${id}.wasm`, zkey: `${base}/${id}_final.zkey` };
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

/**
 * Outcome of probing the companion package. A discriminated union, so
 * `artifacts` is only readable after checking `found`.
 */
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
        // Returned so `ProverArtifactsMissingError` can report why the
        // companion did not resolve.
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
