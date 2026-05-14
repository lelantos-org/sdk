// Pluggable note scanner.

import type { Field, Jubjub, Poseidon } from "../crypto/index.js";
import type { FmdDetectionKey } from "../fmd/fmd.js";
import { type ScanHit, type ScanInput, scanNotes } from "./sync.js";

export interface Scanner {
    /// Trial-decrypt `inputs` with `ivk`. When `detectionKey` is supplied,
    /// implementations SHOULD use FMD to skip not-mine notes before ECDH+ChaCha.
    /// Result order MUST match input order (filtered to hits).
    scan(ivk: Field, inputs: ScanInput[], detectionKey?: FmdDetectionKey): Promise<ScanHit[]>;

    /// Release held resources (workers, native handles).
    dispose?(): Promise<void> | void;
}

/// In-process scanner. No worker/scheduler overhead.
export class LocalScanner implements Scanner {
    constructor(
        private readonly J: Jubjub,
        private readonly P: Poseidon,
    ) {}

    async scan(
        ivk: Field,
        inputs: ScanInput[],
        detectionKey?: FmdDetectionKey,
    ): Promise<ScanHit[]> {
        return scanNotes(this.J, this.P, ivk, inputs, detectionKey);
    }
}

export type { ScanHit, ScanInput } from "./sync.js";
