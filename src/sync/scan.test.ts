import { beforeAll, describe, expect, it } from "vitest";
import {
    BABYJUB_SUBGROUP_ORDER,
    buildNoteCommitment,
    type Field,
    Jubjub,
    Poseidon,
} from "../crypto/index.js";
import { buildSpendingKey, type SpendingKey } from "../keys/keys.js";
import { clueBitsToPrefix, encodeNotePayload, type NotePayload } from "../notes/codec.js";
import { encryptNote } from "../notes/encrypt.js";
import { emptyScanStats, type ScanInput, scanNotes } from "./scan.js";

// First coverage of the scan loop. The commitment check is the reason this
// file exists: everything else here was already correct, but a hit's `cm` came
// from the feed and nothing reproduced it locally.

describe("scanNotes", () => {
    let P: Poseidon;
    let J: Jubjub;
    let me: SpendingKey;
    let eve: SpendingKey;

    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
        me = buildSpendingKey(P, J, 4242n);
        eve = buildSpendingKey(P, J, 9999n);
    });

    const payload = (value: bigint): NotePayload => ({
        asset: 1n,
        value,
        rho: 12345n,
        rcm: 67890n,
        rcvDep: 1122n,
    });

    /**
     * Wire input for `note` encrypted to `me`. `cm` defaults to the honest
     * commitment; pass one to model a feed (or sender) that disagrees.
     */
    function input(note: NotePayload, opts: { pk?: Field; cm?: Field } = {}): ScanInput {
        const enc = encryptNote({
            J,
            recipientPkD: me.pk_d,
            esk: 777n % BABYJUB_SUBGROUP_ORDER,
            plaintext: encodeNotePayload(note),
        });
        const pk = opts.pk ?? me.pk;
        return {
            ciphertext: new Uint8Array([
                ...clueBitsToPrefix(new Uint8Array([0]), 5),
                ...enc.ciphertext,
            ]),
            epk: enc.epk,
            cm: opts.cm ?? buildNoteCommitment(P, { ...note, pk }),
            leafIndex: 3,
            blockNumber: 9,
        };
    }

    it("returns a note whose commitment reproduces the feed's", () => {
        const stats = emptyScanStats();
        const hits = scanNotes(J, P, me.ivk, [input(payload(500n))], stats);

        expect(hits).toHaveLength(1);
        expect(hits[0]?.value).toBe(500n);
        expect(stats).toMatchObject({ scanned: 1, hits: 1, cmMismatch: 0 });
    });

    it("rejects a note committed under a different pk", () => {
        // The grief case: anyone who knows the address can encrypt a payload to
        // it while committing on chain under someone else's `pk`. The wallet
        // decrypts it, so without the check it lands in the balance and fails
        // only at spend time, after a full prove, with nothing to explain it.
        const note = payload(500n);
        const stats = emptyScanStats();
        const hits = scanNotes(J, P, me.ivk, [input(note, { pk: eve.pk })], stats);

        expect(hits).toHaveLength(0);
        expect(stats).toMatchObject({ scanned: 1, hits: 0, cmMismatch: 1 });
    });

    it("rejects a note whose feed commitment is unrelated to the ciphertext", () => {
        const stats = emptyScanStats();
        const hits = scanNotes(J, P, me.ivk, [input(payload(500n), { cm: 1n })], stats);

        expect(hits).toHaveLength(0);
        expect(stats.cmMismatch).toBe(1);
    });

    it("counts a foreign note as notOurs without touching the commitment check", () => {
        const enc = encryptNote({
            J,
            recipientPkD: eve.pk_d,
            esk: 555n % BABYJUB_SUBGROUP_ORDER,
            plaintext: encodeNotePayload(payload(1n)),
        });
        const stats = emptyScanStats();
        const hits = scanNotes(
            J,
            P,
            me.ivk,
            [
                {
                    ciphertext: new Uint8Array([
                        ...clueBitsToPrefix(new Uint8Array([0]), 5),
                        ...enc.ciphertext,
                    ]),
                    epk: enc.epk,
                    cm: 7n,
                    leafIndex: 0,
                    blockNumber: 0,
                },
            ],
            stats,
        );

        expect(hits).toHaveLength(0);
        expect(stats).toMatchObject({ notOurs: 1, cmMismatch: 0 });
    });

    it("skips a self-pad output before the commitment check", () => {
        // Value-0 pads decrypt cleanly and are unspendable; they are dropped on
        // their own terms, not reported as a commitment mismatch.
        const stats = emptyScanStats();
        const hits = scanNotes(J, P, me.ivk, [input(payload(0n))], stats);

        expect(hits).toHaveLength(0);
        expect(stats).toMatchObject({ zeroValue: 1, cmMismatch: 0 });
    });
});
