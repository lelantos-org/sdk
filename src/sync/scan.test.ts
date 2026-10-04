import { beforeAll, describe, expect, it } from "vitest";
import {
    BABYJUB_SUBGROUP_ORDER,
    buildInner,
    buildNoteCommitment,
    commitWithInner,
    type Field,
    Jubjub,
    Poseidon,
} from "../crypto/index.js";
import { TAG_PK } from "../crypto/tags.js";
import {
    defaultDiversifier,
    deriveDiversifierKey,
    diversifierAt,
    diversifierToField,
} from "../keys/diversifier.js";
import { buildSpendingKey, type SpendingKey } from "../keys/keys.js";
import { clueBitsToPrefix, encodeNotePayload, type NotePayload } from "../notes/codec.js";
import { encryptNote } from "../notes/encrypt.js";
import { emptyScanStats, type ScanInput, scanNotes } from "./scan.js";

// Scan loop coverage, focused on the local commitment check: a hit's `cm` comes
// from the feed and must be reproduced from the plaintext.

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
        // Griefing: anyone who knows the address can encrypt a payload to it while committing on
        // chain under another `pk`. Unchecked, it would enter the balance and fail at spend time.
        const note = payload(500n);
        const stats = emptyScanStats();
        const hits = scanNotes(J, P, me.ivk, [input(note, { pk: eve.pk })], stats);

        expect(hits).toHaveLength(0);
        expect(stats).toMatchObject({ scanned: 1, hits: 0, cmMismatch: 1 });
    });

    it("accepts a note committed under Poseidon(TAG_PK, ivk, d0), from the viewing key alone", () => {
        const pk = P.hash([TAG_PK, me.ivk, defaultDiversifier(me.ivk)]);
        const stats = emptyScanStats();
        const hits = scanNotes(J, P, me.ivk, [input(payload(500n), { pk })], stats);

        expect(pk).toBe(me.pk);
        expect(hits).toHaveLength(1);
        expect(stats).toMatchObject({ scanned: 1, hits: 1, cmMismatch: 0 });
    });

    it("rejects a note committed under a pk no spend opens", () => {
        // The arity-2 hash of `ivk`, the hash under a zero diversifier, and the account's pk at
        // another diversifier index: the scanner derives only the default address's pk.
        const dvk = deriveDiversifierKey(me.ivk);
        const pks = [
            P.hash([TAG_PK, me.ivk]),
            P.hash([TAG_PK, me.ivk, 0n]),
            P.hash([TAG_PK, me.ivk, diversifierToField(diversifierAt(dvk, 1))]),
        ];
        for (const pk of pks) {
            const stats = emptyScanStats();
            const hits = scanNotes(J, P, me.ivk, [input(payload(500n), { pk })], stats);

            expect(hits).toHaveLength(0);
            expect(stats).toMatchObject({ scanned: 1, hits: 0, cmMismatch: 1 });
        }
    });

    it("rejects a note whose feed commitment is unrelated to the ciphertext", () => {
        const stats = emptyScanStats();
        const hits = scanNotes(J, P, me.ivk, [input(payload(500n), { cm: 1n })], stats);

        expect(hits).toHaveLength(0);
        expect(stats.cmMismatch).toBe(1);
    });

    // A deposit publishes `inner` beside its public `(asset, value)`, and the batch circuit builds
    // the leaf from those three; the ciphertext is the depositor's own claim about the note.
    describe("deposit leaves", () => {
        const escrowLeaf = (asset: bigint, publicIn: bigint, note: NotePayload, pk = me.pk) =>
            commitWithInner(P, asset, publicIn, buildInner(P, { ...note, pk }));

        it("returns a note whose plaintext states the escrowed asset and amount", () => {
            const note = payload(500n);
            const stats = emptyScanStats();
            const cm = escrowLeaf(note.asset, 500n, note);
            const hits = scanNotes(J, P, me.ivk, [input(note, { cm })], stats);

            expect(hits).toHaveLength(1);
            expect(hits[0]).toMatchObject({ asset: 1n, value: 500n, cm });
        });

        it("rejects a plaintext that overstates the escrowed amount", () => {
            // The leaf holds 5 units; a note stored as 500 would never open it.
            const note = payload(500n);
            const stats = emptyScanStats();
            const cm = escrowLeaf(note.asset, 5n, note);
            const hits = scanNotes(J, P, me.ivk, [input(note, { cm })], stats);

            expect(hits).toHaveLength(0);
            expect(stats.cmMismatch).toBe(1);
        });

        it("rejects a plaintext that names another asset than the escrow's", () => {
            const note = payload(500n);
            const stats = emptyScanStats();
            const cm = escrowLeaf(2n, 500n, note);
            const hits = scanNotes(J, P, me.ivk, [input(note, { cm })], stats);

            expect(hits).toHaveLength(0);
            expect(stats.cmMismatch).toBe(1);
        });

        it("rejects an inner built under another pk", () => {
            const note = payload(500n);
            const stats = emptyScanStats();
            const cm = escrowLeaf(note.asset, 500n, note, eve.pk);
            const hits = scanNotes(J, P, me.ivk, [input(note, { cm })], stats);

            expect(hits).toHaveLength(0);
            expect(stats.cmMismatch).toBe(1);
        });

        it("rejects the published inner served in place of the leaf", () => {
            const note = payload(500n);
            const stats = emptyScanStats();
            const cm = buildInner(P, { ...note, pk: me.pk });
            const hits = scanNotes(J, P, me.ivk, [input(note, { cm })], stats);

            expect(hits).toHaveLength(0);
            expect(stats.cmMismatch).toBe(1);
        });

        it("skips the zero-value fee note of a deposit that charged no fee", () => {
            // Its leaf names asset 0, "no asset".
            const note = { ...payload(0n), asset: 0n };
            const stats = emptyScanStats();
            const cm = escrowLeaf(0n, 0n, note);
            const hits = scanNotes(J, P, me.ivk, [input(note, { cm })], stats);

            expect(hits).toHaveLength(0);
            expect(stats).toMatchObject({ zeroValue: 1, cmMismatch: 0 });
        });
    });

    it("rejects a valued note under asset id 0", () => {
        // No leaf holds value under "no asset", whatever commitment the feed pairs with it.
        const note = { ...payload(500n), asset: 0n };
        const stats = emptyScanStats();
        const hits = scanNotes(J, P, me.ivk, [input(note)], stats);

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
        // Value-0 pads are counted as `zeroValue`, not as a commitment mismatch.
        const stats = emptyScanStats();
        const hits = scanNotes(J, P, me.ivk, [input(payload(0n))], stats);

        expect(hits).toHaveLength(0);
        expect(stats).toMatchObject({ zeroValue: 1, cmMismatch: 0 });
    });
});
