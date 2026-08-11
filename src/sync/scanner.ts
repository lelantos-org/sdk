// Pluggable note scanner.

import type { Field, Jubjub } from "../crypto/index.js";
import { emptyScanStats, type ScanHit, type ScanInput, type ScanStats, scanNotes } from "./scan.js";

export interface Scanner {
    /**
     * Trial-decrypt `inputs` with `ivk`. Result order MUST match input order
     * (filtered to hits).
     *
     * There is no client-side FMD pre-filter: the note feed does not carry
     * `clue.R`, so one is not implementable here today. For FMD filtering
     * use `syncStrategy: { kind: "matches", token }`, which does it
     * server-side — trading some anonymity for bandwidth. See
     * `./worker/protocol.ts` for the full reasoning.
     */
    scan(ivk: Field, inputs: ScanInput[]): Promise<ScanHit[]>;

    /** Release held resources (workers, native handles). */
    dispose?(): Promise<void> | void;
}

/** In-process scanner. No worker/scheduler overhead. */
export class LocalScanner implements Scanner {
    /** Tallies from the most recent `scan`. */
    lastStats: ScanStats = emptyScanStats();

    constructor(private readonly J: Jubjub) {}

    async scan(ivk: Field, inputs: ScanInput[]): Promise<ScanHit[]> {
        this.lastStats = emptyScanStats();
        return scanNotes(this.J, ivk, inputs, this.lastStats);
    }
}

export type { ScanHit, ScanInput, ScanStats } from "./scan.js";
