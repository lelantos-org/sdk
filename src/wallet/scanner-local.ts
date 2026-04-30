// Default Scanner — runs the sync `scanNotes` loop in-process.
// Zero behavior change vs. the pre-Scanner code path.

import type { Jubjub, Field } from "../crypto/index";
import { scanNotes, type ScanInput, type ScanHit } from "../sync";
import type { FmdDetectionKey } from "../fmd";
import type { Scanner } from "./scanner";

export class LocalScanner implements Scanner {
    constructor(private readonly J: Jubjub) {}

    async scan(
        ivk: Field,
        inputs: ScanInput[],
        detectionKey?: FmdDetectionKey,
    ): Promise<ScanHit[]> {
        return scanNotes(this.J, ivk, inputs, detectionKey);
    }
}
