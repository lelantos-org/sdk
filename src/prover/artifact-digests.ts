// Pinned digests of the published proving artifacts.
//
// A proving key and its witness calculator are trusted inputs: the witness
// holds the spending key, and a substituted zkey can make its proofs leak
// witness values to whoever receives them, whether or not they verify on-chain.
// An artifact from a CDN or a browser cache is therefore checked against the
// digest of its release before it is parsed.
//
// The digests are those of the `@lelantos-org/circuits` version pinned as a
// peer dependency; `artifacts.test.ts` hashes the installed package against
// them. Every circuits release re-runs the setup, so its keys and digests differ.
//
// Backend-agnostic: does not import snarkjs.

import { bytesToBareHex } from "../core/hex.js";
import type { ArtifactDigests } from "./types.js";

/**
 * SHA-256 of the artifacts `@lelantos-org/circuits` publishes, by shape id.
 *
 * Applied automatically to artifacts the SDK locates itself (the companion
 * package, `prover.cdn`). Pass an entry as `artifacts.sha256` to pin the same
 * files served from a URL of your own:
 *
 * ```ts
 * prover: { artifacts: { circuit, zkey, sha256: PROVER_ARTIFACT_SHA256["4x6"] } }
 * ```
 */
export const PROVER_ARTIFACT_SHA256: Readonly<Record<string, Readonly<ArtifactDigests>>> =
    Object.freeze({
        "4x6": Object.freeze({
            circuit: "649c97e48ecf7f91fd41a4c1eed8c7c3d3d29d1ab3709f6b5e235276b06e3c21",
            zkey: "04e6daecd8a4a7da4ccc41492cd6aad76f5ea5ee44107120eb50ef2ef1948692",
        }),
    });

/**
 * SHA-256 of `bytes`, lowercase hex.
 *
 * Uses Web Crypto where present: native, and off the calling thread. It is
 * absent in a non-secure browser context, where a pure-JS fallback, imported on
 * that path only, hashes on the calling thread.
 *
 * @internal
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) {
        const { sha256 } = await import("@noble/hashes/sha256");
        return bytesToBareHex(sha256(bytes));
    }
    // `BufferSource` excludes SharedArrayBuffer-backed views; artifact bytes come
    // from `fetch`, `readFile` or the cache, never the rayon shared heap.
    return bytesToBareHex(
        new Uint8Array(await subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
    );
}
