// Pluggable note scanner.
//
// `Scanner` is the seam: the wallet's sync loop calls `.scan(ivk, inputs,
// detectionKey)` and gets back the subset that decrypts. Default impl is
// `LocalScanner` (in-process). For browser apps with a worker pool see
// `scanner-worker-pool.ts` / `browserWorkerScanner`.

import type { Field, Jubjub, Poseidon } from "../crypto/index.js";
import type { FmdDetectionKey } from "../fmd.js";
import { type ScanHit, type ScanInput, scanNotes } from "../sync.js";

export interface Scanner {
    /// Trial-decrypt `inputs` with `ivk`. When `detectionKey` is supplied,
    /// implementations SHOULD use FMD to skip clearly-not-mine notes
    /// before paying the ECDH+ChaCha cost.
    ///
    /// Result order MUST match input order (filtered to hits).
    scan(ivk: Field, inputs: ScanInput[], detectionKey?: FmdDetectionKey): Promise<ScanHit[]>;

    /// Optional: release any held resources (workers, native handles).
    dispose?(): Promise<void> | void;
}

/// Default scanner — runs the synchronous `scanNotes` loop in-process. No
/// worker/scheduler overhead; ideal for Node and small browser workloads.
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

export type { ScanHit, ScanInput } from "../sync.js";
