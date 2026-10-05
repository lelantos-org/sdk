// Sender and recipient sides of one output to a diversified address. The sender holds the address
// and its own `ock`; the recipient holds `ivk` and what the note plaintext and the chain carry:
// `d`, `rseed`, `rho`, `epk`, the clue.
//
// The first property composes the primitives alone: no wallet, codec or cipher. The second goes
// through the published forms: the address string, the 224-byte plaintext and the 242-byte wire
// ciphertext.

import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { sealOutput } from "./bundle/common.js";
import { BABYJUB_SUBGROUP_ORDER, BN254_FR, POW_2_64 } from "./core/field.js";
import { buildNoteCommitment } from "./crypto/commit.js";
import { deriveIvk } from "./crypto/derive.js";
import { diversifiedBase } from "./crypto/diversified-base.js";
import { Jubjub } from "./crypto/jubjub-wasm/index.js";
import { Poseidon } from "./crypto/poseidon.js";
import { fmdFlagOnBase, fmdTest } from "./fmd/clue.js";
import {
    fmdDiversifiedDetectionKey,
    fmdDiversifiedFlagKey,
    fmdExpectedClue,
} from "./fmd/diversified.js";
import { decodeAddress } from "./keys/address.js";
import { buildDiversifiedKeys, deriveDiversifiedPk, deriveDkRoot } from "./keys/diversified.js";
import {
    deriveDiversifierKey,
    diversifierAt,
    diversifierIndex,
    diversifierToField,
} from "./keys/diversifier.js";
import { addressFromViewingKey, buildViewingKey } from "./keys/keys.js";
import {
    CLUE_BITS_PREFIX_BYTES,
    decodeNotePayload,
    EMPTY_MEMO,
    NOTE_CIPHERTEXT_BYTES,
    NOTE_PLAINTEXT_BYTES,
} from "./notes/codec.js";
import { decryptNote } from "./notes/encrypt.js";
import { deriveOutgoingKey } from "./notes/outgoing.js";
import { deriveOutputSecret, expandSeed, seedFromSecret } from "./notes/seed.js";
import { emptyScanStats, scanNotes } from "./sync/scan.js";
import { sealedScanInput } from "./test-utils/outputs.js";

const q = BABYJUB_SUBGROUP_ORDER;

/**
 * One output: the account on each side, the index of the address paid, and the note. `min` bounds
 * the asset and the value from below.
 */
function outputArbitrary(min: bigint) {
    return fc.record({
        // Leaves room for the stranger account at `recipientNsk + 1`.
        recipientNsk: fc.bigInt({ min: 1n, max: BN254_FR - 2n }),
        senderNsk: fc.bigInt({ min: 1n, max: BN254_FR - 1n }),
        index: fc.integer({ min: 0, max: 2 ** 32 - 1 }),
        chainId: fc.bigInt({ min: 1n, max: POW_2_64 }),
        rho: fc.bigInt({ min: 0n, max: BN254_FR - 1n }),
        asset: fc.bigInt({ min, max: POW_2_64 - 1n }),
        value: fc.bigInt({ min, max: POW_2_64 - 1n }),
        // The nullifiers of the output's spend: none for a deposit, one per input slot.
        nullifiers: fc.array(fc.bigInt({ min: 0n, max: BN254_FR - 1n }), { maxLength: 4 }),
    });
}

describe("diversified address, sender to recipient", () => {
    let J: Jubjub;
    let P: Poseidon;
    beforeAll(async () => {
        J = await Jubjub.build();
        P = await Poseidon.build();
    });

    it("the recipient recovers pk, the ephemeral, the commitment blinder and the clue", () => {
        fc.assert(
            fc.property(
                outputArbitrary(0n),
                ({ recipientNsk, senderNsk, index, chainId, rho, asset, value, nullifiers }) => {
                    const ivk = deriveIvk(P, recipientNsk);

                    // The recipient publishes an address: (d, pk, pk_d, ck_d).
                    const dvk = deriveDiversifierKey(ivk);
                    const dBytes = diversifierAt(dvk, index);
                    const address = buildDiversifiedKeys(P, J, ivk, diversifierToField(dBytes));

                    // Sender: the address, the note and its own ock.
                    const gD = diversifiedBase(J, P, diversifierToField(dBytes));
                    const output = {
                        chainId,
                        rho,
                        asset,
                        value,
                        d: dBytes,
                        pk_d: J.packPoint(address.pk_d),
                        pk: address.pk,
                        ck_d: J.packPoint(address.ck_d),
                        nullifiers,
                        memo: EMPTY_MEMO,
                    };
                    const osk = deriveOutputSecret(deriveOutgoingKey(senderNsk), output);
                    const rseed = seedFromSecret(osk);
                    const sent = expandSeed(rseed, rho);
                    const epk = J.mulPointEscalar(gD, sent.esk);
                    const senderShared = J.mulPointEscalar(address.pk_d, sent.esk);
                    const clue = fmdFlagOnBase(
                        J,
                        P,
                        fmdDiversifiedFlagKey(J, P, address.ck_d, gD),
                        gD,
                        sent.fmdR,
                    );

                    // Recipient: ivk, plus (dBytes, rseed, rho) from the plaintext.
                    const dkRoot = deriveDkRoot(P, ivk);
                    expect(fmdTest(J, P, fmdDiversifiedDetectionKey(P, dkRoot), clue)).toBe(true);
                    expect(J.mulPointEscalar(epk, ivk % q)).toEqual(senderShared);

                    expect(diversifierIndex(deriveDiversifierKey(ivk), dBytes)).toBe(index);
                    const seenD = diversifierToField(dBytes);
                    expect(deriveDiversifiedPk(P, ivk, seenD)).toBe(address.pk);

                    const got = expandSeed(rseed, rho);
                    expect(got).toEqual(sent);
                    expect(J.mulPointEscalar(diversifiedBase(J, P, seenD), got.esk)).toEqual(epk);
                    expect(fmdExpectedClue(J, P, dkRoot, seenD, got.fmdR)).toEqual(clue);

                    // A sender that re-derives the output reaches the same seed.
                    expect(
                        seedFromSecret(deriveOutputSecret(deriveOutgoingKey(senderNsk), output)),
                    ).toEqual(rseed);

                    // Another account does not recognise the diversifier.
                    const strangerDvk = deriveDiversifierKey(deriveIvk(P, recipientNsk + 1n));
                    expect(diversifierIndex(strangerDvk, dBytes)).toBeNull();
                },
            ),
            { numRuns: 25, seed: 0x1e1a },
        );
    });

    it("an output sealed to the address string scans for its owner and for no one else", () => {
        fc.assert(
            fc.property(
                // The scanner drops a note of asset 0 or value 0.
                outputArbitrary(1n),
                ({ recipientNsk, senderNsk, index, chainId, rho, asset, value, nullifiers }) => {
                    const ivk = deriveIvk(P, recipientNsk);
                    const address = addressFromViewingKey(P, J, buildViewingKey(P, ivk), index);
                    expect(address).toHaveLength(195);

                    // Sender: the address string, the note and its own ock.
                    const recipient = decodeAddress(J, address);
                    const { note, aux } = sealOutput(J, P, {
                        outgoingKey: deriveOutgoingKey(senderNsk),
                        chainId,
                        rho,
                        asset,
                        value,
                        recipient,
                        nullifiers,
                    });
                    const { ciphertext } = aux.aux;
                    expect(ciphertext).toHaveLength(NOTE_CIPHERTEXT_BYTES);

                    // Recipient: ivk and the published output.
                    const position = { leafIndex: 0, blockNumber: 0 };
                    const input = sealedScanInput(P, J, { note, aux }, position);
                    const plaintext = decryptNote({
                        J,
                        ivk,
                        note: {
                            epk: input.epk,
                            ciphertext: ciphertext.subarray(CLUE_BITS_PREFIX_BYTES),
                        },
                    });
                    expect(plaintext).toHaveLength(NOTE_PLAINTEXT_BYTES);
                    expect(decodeNotePayload(plaintext!).d).toBe(recipient.d);
                    expect(scanNotes(J, P, ivk, [input])).toEqual([
                        {
                            asset,
                            value,
                            rho,
                            rcm: note.rcm,
                            d: recipient.d,
                            cm: buildNoteCommitment(P, note),
                            ...position,
                        },
                    ]);

                    // Another account sees a note addressed to someone else.
                    const stats = emptyScanStats();
                    const stranger = deriveIvk(P, recipientNsk + 1n);
                    expect(scanNotes(J, P, stranger, [input], stats)).toEqual([]);
                    expect(stats.notOurs).toBe(1);
                },
            ),
            { numRuns: 10, seed: 0x1e1b },
        );
    });
});
