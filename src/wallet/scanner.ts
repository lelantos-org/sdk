// Pluggable note scanner. Default = synchronous in-process trial-decrypt
// loop (LocalScanner). Apps may swap in a Worker-pool, WASM-backed, or
// remote scanner without touching the wallet sync path.
//
// Mirrors the `Prover` injection pattern.

import type { Field } from "../crypto/index";
import type { ScanInput, ScanHit } from "../sync";
import type { FmdDetectionKey } from "../fmd";

export interface Scanner {
    /// Trial-decrypt `inputs` with `ivk`. When `detectionKey` is given,
    /// implementations SHOULD use FMD to skip clearly-not-mine notes
    /// before paying the ECDH+ChaCha cost.
    ///
    /// Result order MUST match input order (filtered to hits).
    scan(ivk: Field, inputs: ScanInput[], detectionKey?: FmdDetectionKey): Promise<ScanHit[]>;

    /// Optional: release any held resources (workers, native handles).
    dispose?(): Promise<void> | void;
}

export type { ScanInput, ScanHit } from "../sync";
