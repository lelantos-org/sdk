// Pluggable note scanner.

import type { Field, Jubjub, Poseidon } from "../crypto/index.js";
import { emptyScanStats, type ScanHit, type ScanInput, type ScanStats, scanNotes } from "./scan.js";

export interface Scanner {
    /**
     * Trial-decrypt `inputs` with `ivk`. Result order must match input order (filtered to hits).
     *
     * For FMD filtering use `syncStrategy: { kind: "matches", token }`, which filters server-side,
     * trading some anonymity for bandwidth.
     */
    scan(ivk: Field, inputs: ScanInput[]): Promise<ScanHit[]>;

    /** Release held resources (workers, native handles). */
    dispose?(): Promise<void> | void;
}

/** In-process scanner. */
export class LocalScanner implements Scanner {
    /** Tallies from the most recent `scan`. */
    lastStats: ScanStats = emptyScanStats();

    /** `P` reproduces each hit's commitment; see {@link scanNotes}. */
    constructor(
        private readonly J: Jubjub,
        private readonly P: Poseidon,
    ) {}

    async scan(ivk: Field, inputs: ScanInput[]): Promise<ScanHit[]> {
        this.lastStats = emptyScanStats();
        return scanNotes(this.J, this.P, ivk, inputs, this.lastStats);
    }
}
