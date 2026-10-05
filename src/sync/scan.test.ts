import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { blake2b } from "@noble/hashes/blake2";
import { beforeAll, describe, expect, it } from "vitest";
import {
    BN254_FR,
    buildInner,
    buildNoteCommitment,
    commitWithInner,
    deriveIvk,
    type Field,
    Jubjub,
    Poseidon,
} from "../crypto/index.js";
import { TAG_PK } from "../crypto/tags.js";
import { fmdFlagOnBase, fmdTest } from "../fmd/clue.js";
import { fmdDiversifiedDetectionKey, fmdDiversifiedFlagKey } from "../fmd/diversified.js";
import { buildDiversifiedKeys, type DiversifiedKeys, deriveDkRoot } from "../keys/diversified.js";
import { diversifierForIndex } from "../keys/diversifier.js";
import { buildOutputAux } from "../notes/aux.js";
import {
    clueBitsToPrefix,
    encodeNotePayload,
    type NotePayload,
    withClueBitsPrefix,
} from "../notes/codec.js";
import { encryptNote } from "../notes/encrypt.js";
import { expandSeed } from "../notes/seed.js";
import { clueOf, scanInputOf } from "../test-utils/outputs.js";
import { emptyScanStats, type ScanInput, type ScanStats, scanNotes } from "./scan.js";
import { LocalScanner } from "./scanner.js";

// Scan loop coverage. Everything a sender publishes beside a ciphertext (the commitment, the
// ephemeral key, the clue) comes from the feed, and each must be reproduced from the plaintext.

/** An account's viewing key, with its address at any diversifier index. */
interface Account {
    ivk: Field;
    at(index: number): DiversifiedKeys;
}

/** What `seal` builds honestly unless told otherwise. */
interface SealOpts {
    asset?: Field;
    value?: Field;
    rho?: Field;
    rseed?: Uint8Array;
    /** Diversifier the plaintext names. Default: the recipient's. */
    d?: Field;
    /** Commitment key. Default: the recipient's `pk`. */
    pk?: Field;
    /** The feed's leaf. Default: the commitment of the note under `pk`. */
    cm?: Field;
    /** ECDH ephemeral secret. Default: the seed's. */
    esk?: Field;
    /** Address whose base carries `epk`. Default: the recipient. */
    epkBase?: DiversifiedKeys;
    /** Clue blinder. Default: the seed's. */
    fmdR?: Field;
    /** Address the clue is flagged for. Default: the recipient. */
    clueFor?: DiversifiedKeys;
}

describe("scanNotes", () => {
    let P: Poseidon;
    let J: Jubjub;
    let me: Account;
    let eve: Account;

    const RHO = 12345n;
    const RSEED = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i);

    function account(nsk: Field): Account {
        const ivk = deriveIvk(P, nsk);
        return {
            ivk,
            at: (index) => buildDiversifiedKeys(P, J, ivk, diversifierForIndex(ivk, index)),
        };
    }

    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
        me = account(4242n);
        eve = account(9999n);
    });

    /**
     * The feed row of an output paying `to`, built from the primitives so that each published part
     * can be made to disagree with the plaintext on its own.
     */
    function seal(to: DiversifiedKeys, opts: SealOpts = {}): ScanInput {
        const note: NotePayload = {
            asset: opts.asset ?? 1n,
            value: opts.value ?? 500n,
            rho: opts.rho ?? RHO,
            rseed: opts.rseed ?? RSEED,
            d: opts.d ?? to.d,
        };
        const seed = expandSeed(note.rseed, note.rho);
        const flagged = opts.clueFor ?? to;
        const clue = fmdFlagOnBase(
            J,
            P,
            fmdDiversifiedFlagKey(J, P, flagged.ck_d, flagged.g_d),
            flagged.g_d,
            opts.fmdR ?? seed.fmdR,
        );
        const enc = encryptNote({
            J,
            gD: (opts.epkBase ?? to).g_d,
            recipientPkD: (opts.epkBase ?? to).pk_d,
            esk: opts.esk ?? seed.esk,
            plaintext: encodeNotePayload(note),
        });
        return {
            ciphertext: withClueBitsPrefix(clueBitsToPrefix(clue.bits, clue.gamma), enc.ciphertext),
            epk: enc.epk,
            clueR: clue.R,
            cm:
                opts.cm ??
                buildNoteCommitment(P, {
                    asset: note.asset,
                    value: note.value,
                    pk: opts.pk ?? to.pk,
                    rho: note.rho,
                    rcm: seed.rcm,
                }),
            leafIndex: 3,
            blockNumber: 9,
        };
    }

    /** Scan one input as `me`; return the hits and the tallies. */
    function scan(...inputs: ScanInput[]) {
        const stats = emptyScanStats();
        const hits = scanNotes(J, P, me.ivk, inputs, stats);
        return { hits, stats };
    }

    /** Every tally at zero except those named. */
    const tallies = (over: Partial<ScanStats>): ScanStats => ({ ...emptyScanStats(), ...over });

    /** Scanned alone as `me`, `input` is no hit and counts under `reason` only. */
    function expectRejected(
        input: ScanInput,
        reason: Exclude<keyof ScanStats, "scanned" | "hits">,
    ) {
        const { hits, stats } = scan(input);

        expect(hits).toHaveLength(0);
        expect(stats).toEqual(tallies({ scanned: 1, [reason]: 1 }));
    }

    describe("accepted notes", () => {
        it("returns a note sent to the default address", () => {
            const to = me.at(0);
            const { hits, stats } = scan(seal(to));

            expect(hits).toEqual([
                {
                    asset: 1n,
                    value: 500n,
                    rho: RHO,
                    rcm: expandSeed(RSEED, RHO).rcm,
                    d: to.d,
                    cm: seal(to).cm,
                    leafIndex: 3,
                    blockNumber: 9,
                },
            ]);
            expect(stats).toEqual(tallies({ scanned: 1, hits: 1 }));
        });

        it("returns a note sent to any other address of the account", () => {
            for (const index of [1, 7, 2 ** 32 - 1]) {
                const to = me.at(index);
                const { hits, stats } = scan(seal(to));

                expect(to.d).not.toBe(me.at(0).d);
                expect(hits).toHaveLength(1);
                expect(hits[0]).toMatchObject({ value: 500n, d: to.d });
                expect(stats).toEqual(tallies({ scanned: 1, hits: 1 }));
            }
        });

        it("returns notes to several addresses in one pass, each with its own diversifier", () => {
            const a = me.at(0);
            const b = me.at(7);
            const { hits, stats } = scan(
                seal(a, { rho: 1n }),
                seal(b, { rho: 2n }),
                seal(a, { rho: 3n }),
            );

            expect(hits.map((h) => h.d)).toEqual([a.d, b.d, a.d]);
            expect(stats).toEqual(tallies({ scanned: 3, hits: 3 }));
        });

        it("accepts a diversifier no index of the account maps to", () => {
            // Ownership is `pk_d = ivk · g_d`, which holds for every 16-byte `d`.
            for (const d of [0n, 12345n, (1n << 128n) - 1n]) {
                const to = buildDiversifiedKeys(P, J, me.ivk, d);
                const { hits, stats } = scan(seal(to));

                expect(hits[0]?.d).toBe(d);
                expect(stats).toEqual(tallies({ scanned: 1, hits: 1 }));
            }
        });

        it("returns an output built by buildOutputAux", () => {
            const to = me.at(7);
            const note: NotePayload = { asset: 1n, value: 500n, rho: RHO, rseed: RSEED, d: to.d };
            const { rcm, esk, fmdR } = expandSeed(RSEED, RHO);
            const { aux } = buildOutputAux({
                J,
                P,
                recipientFlagKey: fmdDiversifiedFlagKey(J, P, to.ck_d, to.g_d),
                recipientPkD: to.pk_d,
                gD: to.g_d,
                note,
                esk,
                fmdR,
            });
            const cm = buildNoteCommitment(P, { asset: 1n, value: 500n, pk: to.pk, rho: RHO, rcm });
            const { hits, stats } = scan(scanInputOf(J, aux, { cm, leafIndex: 0, blockNumber: 0 }));

            expect(hits).toHaveLength(1);
            expect(stats).toEqual(tallies({ scanned: 1, hits: 1 }));
        });

        it("reports the same tallies through LocalScanner", async () => {
            const scanner = new LocalScanner(J, P);
            const hits = await scanner.scan(me.ivk, [
                seal(me.at(1)),
                seal(me.at(1), { esk: 5n }),
                seal(eve.at(0)),
            ]);

            expect(hits).toHaveLength(1);
            expect(scanner.lastStats).toEqual(
                tallies({ scanned: 3, hits: 1, ephemeralMismatch: 1, notOurs: 1 }),
            );
        });
    });

    describe("the commitment", () => {
        it("rejects a note committed under a different pk", () => {
            // Griefing: anyone who knows the address can encrypt a payload to it while committing
            // on chain under another `pk`. Unchecked, it would enter the balance and fail at spend
            // time.
            expectRejected(seal(me.at(0), { pk: eve.at(0).pk }), "cmMismatch");
        });

        it("derives pk as Poseidon(TAG_PK, ivk, d) for the plaintext's d", () => {
            const to = me.at(7);
            const pk = P.hash([TAG_PK, me.ivk, to.d]);

            expect(pk).toBe(to.pk);
            expect(scan(seal(to, { pk })).stats).toEqual(tallies({ scanned: 1, hits: 1 }));
        });

        it("rejects a note committed under a pk no spend of it opens", () => {
            // The arity-2 hash of `ivk`, the hash under a zero diversifier, and the account's pk at
            // another address than the one the plaintext names.
            const to = me.at(1);
            const pks = [P.hash([TAG_PK, me.ivk]), P.hash([TAG_PK, me.ivk, 0n]), me.at(0).pk];
            for (const pk of pks) {
                expectRejected(seal(to, { pk }), "cmMismatch");
            }
        });

        it("rejects a note whose feed commitment is unrelated to the ciphertext", () => {
            expectRejected(seal(me.at(0), { cm: 1n }), "cmMismatch");
        });

        it("rejects a commitment blinded by anything but the seed's rcm", () => {
            const to = me.at(0);
            const { rcm } = expandSeed(RSEED, RHO);
            const cm = buildNoteCommitment(P, {
                asset: 1n,
                value: 500n,
                pk: to.pk,
                rho: RHO,
                rcm: rcm + 1n,
            });

            expectRejected(seal(to, { cm }), "cmMismatch");
        });

        it("rejects a valued note under asset id 0", () => {
            // No leaf holds value under "no asset", whatever commitment the feed pairs with it.
            expectRejected(seal(me.at(0), { asset: 0n }), "cmMismatch");
        });

        // A deposit publishes `inner` beside its public `(asset, value)`, and the batch circuit
        // builds the leaf from those three; the ciphertext is the depositor's own claim about the
        // note.
        describe("deposit leaves", () => {
            const escrowLeaf = (asset: bigint, publicIn: bigint, pk: Field) =>
                commitWithInner(
                    P,
                    asset,
                    publicIn,
                    buildInner(P, { pk, rho: RHO, rcm: expandSeed(RSEED, RHO).rcm }),
                );

            it("returns a note whose plaintext states the escrowed asset and amount", () => {
                const to = me.at(7);
                const cm = escrowLeaf(1n, 500n, to.pk);
                const { hits } = scan(seal(to, { cm }));

                expect(hits).toHaveLength(1);
                expect(hits[0]).toMatchObject({ asset: 1n, value: 500n, cm, d: to.d });
            });

            it("rejects a plaintext that overstates the escrowed amount", () => {
                // The leaf holds 5 units; a note stored as 500 would never open it.
                const to = me.at(0);
                expectRejected(seal(to, { cm: escrowLeaf(1n, 5n, to.pk) }), "cmMismatch");
            });

            it("rejects a plaintext that names another asset than the escrow's", () => {
                const to = me.at(0);
                expectRejected(seal(to, { cm: escrowLeaf(2n, 500n, to.pk) }), "cmMismatch");
            });

            it("rejects an inner built under another pk", () => {
                const cm = escrowLeaf(1n, 500n, eve.at(0).pk);
                expectRejected(seal(me.at(0), { cm }), "cmMismatch");
            });

            it("rejects the published inner served in place of the leaf", () => {
                const to = me.at(0);
                const cm = buildInner(P, { pk: to.pk, rho: RHO, rcm: expandSeed(RSEED, RHO).rcm });
                expectRejected(seal(to, { cm }), "cmMismatch");
            });

            it("skips a zero-value deposit leaf sealed to the account", () => {
                // Its leaf names asset 0, "no asset".
                const to = me.at(0);
                const cm = escrowLeaf(0n, 0n, to.pk);
                expectRejected(seal(to, { asset: 0n, value: 0n, cm }), "zeroValue");
            });
        });
    });

    describe("the ephemeral key", () => {
        it("rejects a note encrypted under a secret other than the seed's", () => {
            const { esk } = expandSeed(RSEED, RHO);
            for (const other of [esk + 1n, 777n]) {
                expectRejected(seal(me.at(1), { esk: other }), "ephemeralMismatch");
            }
        });

        it("rejects a note sent on one address's base that names another address", () => {
            // A sender holding two addresses encrypts to the first while the plaintext and the
            // commitment name the second. `ivk` opens it only if both are one account's, so
            // accepting it would confirm the link.
            const a = me.at(1);
            const b = me.at(2);
            const probe = seal(b, { epkBase: a });

            expect(probe.cm).toBe(seal(b).cm);
            expectRejected(probe, "ephemeralMismatch");
        });

        it("rejects an ephemeral key carrying a torsion term", () => {
            // Trial decryption clears the cofactor, so `T + esk · g_d` opens under the key of
            // `esk · g_d`. The packed bytes differ, and only the torsion-free point is accepted.
            const to = me.at(1);
            const honest = seal(to);
            const { esk } = expandSeed(RSEED, RHO);
            // A point of order 8.
            const T = J.unpackPoint(
                Uint8Array.from(
                    Buffer.from(
                        "77d6d0af811efdaba0b534826dc591b72c94a64b7d12c16314d3721121b7ab0a",
                        "hex",
                    ),
                ),
            );
            if (!T) throw new Error("torsion fixture does not decode");
            expect(J.mulPointEscalar(T, 8n)).toEqual([0n, 1n]);
            expect(J.mulPointEscalar(T, 4n)).not.toEqual([0n, 1n]);

            const epk = J.packPoint(J.addPoint(T, J.mulPointEscalar(to.g_d, esk)));
            const utf8 = (s: string) => new TextEncoder().encode(s);
            const shared = J.packPoint(J.mulPointEscalar(to.pk_d, esk));
            const key = blake2b(
                new Uint8Array([...utf8("lelantos.note.kdf.v1"), ...epk, ...shared]),
                { dkLen: 32 },
            );
            const nonce = blake2b(new Uint8Array([...utf8("lelantos.note.nonce.v1"), ...epk]), {
                dkLen: 12,
            });
            const note: NotePayload = { asset: 1n, value: 500n, rho: RHO, rseed: RSEED, d: to.d };
            const body = chacha20poly1305(key, nonce).encrypt(encodeNotePayload(note));
            const crafted: ScanInput = {
                ...honest,
                epk,
                ciphertext: withClueBitsPrefix(honest.ciphertext.subarray(0, 2), body),
            };

            expect(J.tryDecryptNote(me.ivk, epk, body)).not.toBeNull();
            expectRejected(crafted, "ephemeralMismatch");
        });
    });

    describe("the clue", () => {
        const flipped = (bytes: Uint8Array, index: number, mask: number) => {
            const out = bytes.slice();
            out[index] = (out[index] ?? 0) ^ mask;
            return out;
        };

        it("rejects a published clue point other than the seed's", () => {
            const to = me.at(1);
            const honest = seal(to);
            const { fmdR } = expandSeed(RSEED, RHO);
            const others = [
                // Another multiple of the same base.
                J.packPoint(J.mulPointEscalar(to.g_d, fmdR + 1n)),
                // The right scalar on the wrong base.
                J.packPoint(J.mulPointEscalar(J.base8, fmdR)),
                flipped(honest.clueR, 0, 0x01),
                // The same ordinate with the other sign of `x`.
                flipped(honest.clueR, 31, 0x80),
                new Uint8Array(32),
            ];
            for (const clueR of others) {
                expectRejected({ ...honest, clueR }, "clueMismatch");
            }
        });

        it("rejects a bits prefix other than the seed's", () => {
            const honest = seal(me.at(1));
            // Each of the γ = 5 clue bits, then two bits above them, one in each prefix byte.
            const masks: [number, number][] = [
                [1, 0x01],
                [1, 0x02],
                [1, 0x04],
                [1, 0x08],
                [1, 0x10],
                [1, 0x20],
                [0, 0x01],
            ];
            for (const [index, mask] of masks) {
                const ciphertext = flipped(honest.ciphertext, index, mask);
                expectRejected({ ...honest, ciphertext }, "clueMismatch");
            }
        });

        it("rejects a clue built for another address of the same account", () => {
            // The account's detection key accepts this clue, as it does one for any of its
            // addresses; only the recomputation tells the two apart.
            const a = me.at(1);
            const b = me.at(2);
            const probe = seal(a, { clueFor: b });
            const dk = fmdDiversifiedDetectionKey(P, deriveDkRoot(P, me.ivk));

            expect(fmdTest(J, P, dk, clueOf(J, probe))).toBe(true);
            expect(probe.epk).toEqual(seal(a).epk);

            expectRejected(probe, "clueMismatch");
        });

        it("rejects a clue built for a stranger", () => {
            expectRejected(seal(me.at(1), { clueFor: eve.at(0) }), "clueMismatch");
        });

        it("rejects a clue for the right address under a blinder other than the seed's", () => {
            const { fmdR } = expandSeed(RSEED, RHO);
            expectRejected(seal(me.at(1), { fmdR: fmdR + 1n }), "clueMismatch");
        });
    });

    describe("notes that are not hits for other reasons", () => {
        it("counts a foreign note as notOurs without touching the later checks", () => {
            expectRejected(seal(eve.at(0), { cm: 7n }), "notOurs");
        });

        it("skips a zero-value note before the commitment check", () => {
            // Counted as `zeroValue` whatever the feed pairs with it.
            expectRejected(seal(me.at(0), { value: 0n, cm: 1n, esk: 5n }), "zeroValue");
        });

        /** `plaintext` under an honest envelope to `to`, whatever its content. */
        function sealRaw(to: DiversifiedKeys, plaintext: Uint8Array): ScanInput {
            const enc = encryptNote({
                J,
                gD: to.g_d,
                recipientPkD: to.pk_d,
                esk: 777n,
                plaintext,
            });
            return {
                ...seal(to),
                epk: enc.epk,
                ciphertext: withClueBitsPrefix(new Uint8Array(2), enc.ciphertext),
            };
        }

        it("counts a plaintext of another length as decodeFailed", () => {
            // 80 bytes is the plaintext without a diversifier.
            for (const length of [0, 80, 95, 97]) {
                expectRejected(sealRaw(me.at(0), new Uint8Array(length).fill(1)), "decodeFailed");
            }
        });

        it("counts a plaintext whose rho is not a field element as decodeFailed", () => {
            const to = me.at(0);
            for (const rho of [BN254_FR, (1n << 256n) - 1n]) {
                const plaintext = encodeNotePayload({
                    asset: 1n,
                    value: 500n,
                    rho,
                    rseed: RSEED,
                    d: to.d,
                });
                expectRejected(sealRaw(to, plaintext), "decodeFailed");
            }
        });

        // A custom note source can hand over a row of any shape.
        it("counts an ephemeral key or clue point of the wrong length as decodeFailed, and scans on", () => {
            const to = me.at(0);
            const good = seal(to);
            const other = seal(me.at(2), { value: 9n });
            const { hits, stats } = scan(
                good,
                { ...seal(to), epk: good.epk.subarray(0, 31) },
                { ...seal(to), epk: new Uint8Array(33) },
                { ...seal(to), epk: new Uint8Array(0) },
                { ...seal(to), clueR: good.clueR.subarray(0, 31) },
                { ...seal(to), clueR: new Uint8Array(33) },
                other,
            );

            expect(hits.map((h) => [h.value, h.d])).toEqual([
                [500n, to.d],
                [9n, me.at(2).d],
            ]);
            expect(stats).toEqual(tallies({ scanned: 7, decodeFailed: 5, hits: 2 }));
        });

        // A tag failure is the common case, not an error: it must not be counted as one.
        it("counts a 32-byte ephemeral key that opens nothing as notOurs", () => {
            const good = seal(me.at(0));
            const flipped = Uint8Array.from(good.epk);
            flipped[0]! ^= 1;

            const { hits, stats } = scan(
                { ...good, epk: flipped },
                { ...good, epk: new Uint8Array(32).fill(0xff) },
                good,
            );

            expect(hits).toHaveLength(1);
            expect(stats).toEqual(tallies({ scanned: 3, notOurs: 2, hits: 1 }));
        });

        // A note that decrypts stays in the feed: a check that throws on it must cost that note
        // alone, or every later sync would abort at the same row.
        it("counts a throw in any check after decryption as decodeFailed, and scans on", () => {
            const to = me.at(1);
            const poisoned = seal(to, { rho: 66n });
            const { esk, fmdR } = expandSeed(RSEED, 66n);
            /** A curve that throws when it multiplies by `scalar`. */
            const curveFaultOn = (scalar: Field): Jubjub => {
                const faulty: Jubjub = Object.create(J);
                faulty.mulPointEscalar = (p, s) => {
                    if (s === scalar) throw new Error("curve fault");
                    return J.mulPointEscalar(p, s);
                };
                return faulty;
            };
            /** A hash that throws on any input list holding the poisoned note's `rho`. */
            const hashFault = {
                backend: P.backend,
                hash: (xs: Field[]) => {
                    if (xs.includes(66n)) throw new Error("hash fault");
                    return P.hash(xs);
                },
            } as Poseidon;
            // One fault per check: the commitment, the ephemeral key, the clue.
            const faults: [Jubjub, Poseidon][] = [
                [J, hashFault],
                [curveFaultOn(esk), P],
                [curveFaultOn(fmdR), P],
            ];
            const inputs = [seal(to, { rho: 1n }), poisoned, seal(eve.at(0)), seal(me.at(2))];

            expect(scan(...inputs).stats).toEqual(tallies({ scanned: 4, notOurs: 1, hits: 3 }));
            for (const [curve, hash] of faults) {
                const stats = emptyScanStats();
                const hits = scanNotes(curve, hash, me.ivk, inputs, stats);

                expect(hits.map((h) => [h.rho, h.d])).toEqual([
                    [1n, to.d],
                    [RHO, me.at(2).d],
                ]);
                expect(stats).toEqual(
                    tallies({ scanned: 4, notOurs: 1, decodeFailed: 1, hits: 2 }),
                );
            }
        });

        it("keeps scanning after every kind of rejection", () => {
            const to = me.at(1);
            const { fmdR } = expandSeed(RSEED, RHO);
            const { hits, stats } = scan(
                seal(eve.at(0)),
                sealRaw(to, new Uint8Array(80)),
                seal(to, { value: 0n }),
                seal(to, { cm: 1n }),
                seal(to, { esk: 5n }),
                seal(to, { fmdR: fmdR + 1n }),
                seal(to, { rho: 99n }),
            );

            expect(hits.map((h) => h.rho)).toEqual([99n]);
            expect(stats).toEqual({
                scanned: 7,
                notOurs: 1,
                decodeFailed: 1,
                zeroValue: 1,
                cmMismatch: 1,
                ephemeralMismatch: 1,
                clueMismatch: 1,
                hits: 1,
            });
        });
    });
});
