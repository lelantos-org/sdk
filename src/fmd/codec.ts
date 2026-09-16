// FMD wire encodings: clues, detection keys and subscription tokens.
//
// Wire format, pinned against the Rust indexer by deterministic vectors:
//   encoded clue = γ (1B) || R_packed (32B) || c_bits (⌈γ/8⌉ B, LSB-first)

import { FIELD_BYTES, toLeBytes } from "../core/bytes.js";
import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import { bytesToBareHex } from "../core/hex.js";
import type { Field } from "../crypto/poseidon.js";
import { WireFormatError } from "../errors/network.js";
import type { FmdClue } from "./clue.js";
import type { FmdDetectionKey } from "./keys.js";

/** Bytes before a clue's `c_bits`: the γ byte and the packed `R`. */
const CLUE_HEADER_BYTES = 1 + FIELD_BYTES;

/**
 * Reject a γ that cannot appear on the wire (one byte). Distinct from
 * `assertDetectionGamma` (`./keys.ts`), which additionally caps γ at the sender's.
 */
function assertClueGamma(gamma: number): void {
    if (!Number.isInteger(gamma) || gamma < 1 || gamma > 255) {
        throw new WireFormatError("$.clue.gamma", `clue gamma must be 1..255; got ${gamma}`);
    }
}

/**
 * Encode a `FmdDetectionKey` as the `γ * 32`-byte little-endian blob the
 * fmd-webserver subscription endpoint expects. Each scalar is reduced
 * mod `BABYJUB_SUBGROUP_ORDER` then serialized LE-32, matching the Rust
 * `Buffer::concat` over `to_le_bytes()` encoding.
 *
 * @internal
 */
export function detectionKeyToBytes(dk: FmdDetectionKey): Uint8Array {
    const out = new Uint8Array(dk.x.length * FIELD_BYTES);
    for (let i = 0; i < dk.x.length; i++) {
        out.set(toLeBytes(dk.x[i]! % BABYJUB_SUBGROUP_ORDER, FIELD_BYTES), i * FIELD_BYTES);
    }
    return out;
}

/**
 * Hex-encode a detection key for transport, without `0x` prefix, as expected
 * by `POST /v1/subscriptions`.
 */
export function detectionKeyToHex(dk: FmdDetectionKey): string {
    return bytesToBareHex(detectionKeyToBytes(dk));
}

/**
 * Encode a `deriveSubscriptionToken` output as the bare 32-byte hex that
 * `POST /v1/subscriptions` and `GET /v1/matches` expect. LE-32, matching
 * `detectionKeyToHex`.
 *
 * Not reduced mod `BABYJUB_SUBGROUP_ORDER`, unlike the detection scalars: the
 * token is an opaque identifier the server hashes and compares, not a curve
 * scalar, and reducing it would discard entropy.
 */
export function subscriptionTokenToHex(token: Field): string {
    return bytesToBareHex(toLeBytes(token, FIELD_BYTES));
}

/** @internal */
export function encodeClue(c: FmdClue): Uint8Array {
    // `out[0] = gamma` truncates to a byte, so γ = 256 would encode as 0, a
    // clue `fmdTest` accepts against any zero-length detection key.
    assertClueGamma(c.gamma);
    const out = new Uint8Array(CLUE_HEADER_BYTES + c.bits.length);
    out[0] = c.gamma;
    out.set(c.R, 1);
    out.set(c.bits, CLUE_HEADER_BYTES);
    return out;
}

/** @internal */
export function decodeClue(buf: Uint8Array): FmdClue {
    const gamma = buf[0];
    if (gamma === undefined) {
        throw new WireFormatError("$.clue", "clue is empty; expected at least a gamma byte");
    }
    assertClueGamma(gamma);
    const want = CLUE_HEADER_BYTES + Math.ceil(gamma / 8);
    // Exact length, not a minimum, so the encoding is canonical: distinct byte
    // strings never decode to the same `FmdClue`, keeping byte-level dedup and
    // hashing consistent with decoded comparison.
    if (buf.length !== want) {
        throw new WireFormatError(
            "$.clue",
            `clue is ${buf.length} bytes; gamma ${gamma} needs exactly ${want}`,
        );
    }
    return {
        gamma,
        R: buf.slice(1, CLUE_HEADER_BYTES),
        bits: buf.slice(CLUE_HEADER_BYTES),
    };
}
