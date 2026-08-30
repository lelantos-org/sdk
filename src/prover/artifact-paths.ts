// Locating prover artifacts: which files a shape needs, and where they are.
//
// Resolution only — nothing here reads a byte. `bundledProverArtifacts` hands
// back URLs, and `artifact-bytes.ts` is what turns one into content. The split
// is load-bearing: `connect()` resolves eagerly so a misconfigured path throws
// at connect time, while the ~29 MB download stays deferred behind the
// prover build.
//
// Backend-agnostic: nothing here touches snarkjs.

import { ProverArtifactsMissingError } from "../core/errors.js";
import { detectRuntime, IS_NODE, NODE_FS_PROMISES } from "../core/runtime.js";
import { type CircuitShape, DEFAULT_SHAPE, shapeId } from "../core/shape.js";
import { toAbsoluteUrl, urlToString } from "../core/url.js";
import { getLogger } from "../log/logger.js";
import type { ProverArtifacts, ProverPaths } from "./types.js";

export type { ProverArtifacts } from "./types.js";

/**
 * Companion package — published to GitHub Packages (not public npm),
 * so jsDelivr cannot proxy it and there is no built-in browser CDN default.
 * Integrators add it explicitly to avoid pulling ~90 MB of proving keys into
 * every install.
 */
const COMPANION_PKG = "@lelantos-org/circuits";

const log = getLogger("lelantos:prover:artifacts");

/**
 * Coerce `ProverPaths` or `ProverArtifacts` to snarkjs-friendly path strings.
 *
 * @internal
 */
export function resolveArtifacts(input: ProverPaths | ProverArtifacts): {
    wasmPath: string;
    zkeyPath: string;
} {
    // Canonicalised here as well as in `loadArtifactBytes` — not redundantly.
    // This output is what `WorkerProver` posts across to its worker, and inside
    // a worker `location.href` is the *worker script* URL, so a relative path
    // resolved on the far side would resolve against a different base.
    if ("wasmPath" in input) {
        return {
            wasmPath: toAbsoluteUrl(input.wasmPath),
            zkeyPath: toAbsoluteUrl(input.zkeyPath),
        };
    }
    return {
        wasmPath: toAbsoluteUrl(urlToString(input.circuit)),
        zkeyPath: toAbsoluteUrl(urlToString(input.zkey)),
    };
}

/**
 * Resolve default Groth16 prover artifacts for `shape`.
 *
 * Artifacts are named after the shape — `4x6.wasm` / `4x6_final.zkey` — which is the
 * convention the circuits package builds under. Resolution order:
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
            // Probed, not trusted. Returning unconditionally made `tried.push`
            // above dead — it could never reach an error — and deferred a
            // typo'd directory to an `ENOENT` at proof time instead of the
            // `ProverArtifactsMissingError` this function promises.
            if (await bothExist(pair)) return pair;
            tried.push(`env LELANTOS_PROVER_ARTIFACTS_DIR=${envDir} (files not found)`);
        }
        const companion = await tryResolveCompanion(id);
        if (companion.found) return companion.artifacts;
        companionCause = companion.cause;
        tried.push(`npm package ${COMPANION_PKG} (subpath ./${id}/${id}_final.zkey)`);
    }

    // Not `else if`: a CDN is a valid source on Node too. `loadArtifactBytes`
    // handles `http(s)` there perfectly — it only treats a *non*-URL as a
    // filesystem path — so refusing to consider `opts.cdn` outside a browser
    // failed a Node service that had configured exactly the thing it needed,
    // with an error that did not even mention the option it ignored.
    if (opts.cdn) {
        const base = opts.cdn.replace(/\/$/, "");
        return { circuit: `${base}/${id}.wasm`, zkey: `${base}/${id}_final.zkey` };
    }
    tried.push(
        runtime === "browser"
            ? "opts.cdn (browser requires explicit `proverArtifactsCdn`)"
            : "opts.cdn (not set)",
    );

    // The companion's own failure is attached rather than dropped: a package
    // that is installed but broken — missing export subpath, wrong version —
    // is otherwise indistinguishable from one that is absent.
    throw new ProverArtifactsMissingError(tried, id, { cause: companionCause });
}

/**
 * Outcome of probing the companion package. A discriminated union rather than
 * two optional fields, so a caller cannot read `artifacts` without having
 * established that the probe succeeded.
 */
type CompanionProbe =
    | { readonly found: true; readonly artifacts: ProverArtifacts }
    | { readonly found: false; readonly cause?: unknown };

/** Resolve the companion package's artifacts. Never throws. */
async function tryResolveCompanion(id: string): Promise<CompanionProbe> {
    // `import.meta.resolve` sync in Node ≥ 20.6; try/catch so a missing
    // companion reports cleanly.
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
        // Returned rather than swallowed, so the thrown
        // `ProverArtifactsMissingError` can say *why* the companion did not
        // resolve — an installed-but-broken package looks identical to an
        // absent one otherwise.
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
