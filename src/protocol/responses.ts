// Relayer wire contract: response shapes.

import type { Hex32 } from "../core/brand.js";
import type { Field, Point } from "../crypto/index.js";

/** @internal */
export interface RelayerSubmitResponse {
    /** Tx hash once mined. Relayer awaits inclusion before responding. */
    txHash: Hex32;
}

/** @internal */
export interface RelayerIntentResponse {
    txHash: Hex32;
    /**
     * Intent id allocated by `MASP.submitIntent` (== `nextIntentId` at
     * time of the call). Wallet uses this to track escrow lifecycle and
     * for `MASP.cancelIntent` if the relayer never flushes.
     */
    intentId: bigint;
}

/** @internal */
export interface MerkleProofResponse {
    leafIndex: number;
    pathElements: Field[][];
    pathIndices: number[];
    /**
     * Root computed from the path. Caller MUST `isKnownRoot[root]` against
     * the chain before trusting the proof for spending.
     */
    root: Field;
}

/** @internal */
export interface TreeStateResponse {
    leafCount: number;
    root: Field;
    frontier: Field[][];
}

/** @internal */
export interface ScannedNote {
    /** Encrypted note (ChaCha20-Poly1305 body + clueBits prefix). */
    ciphertext: Uint8Array;
    clueR: Point;
    ephPub: Point;
    cm: Field;
    leafIndex: number;
}
