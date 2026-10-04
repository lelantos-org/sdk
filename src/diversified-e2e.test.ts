// Sender and recipient sides of one output to a diversified address, composed from the primitives
// alone: no wallet, codec or cipher. The sender holds the address and its own `ock`; the recipient
// holds `ivk` and what the note plaintext and the chain carry: `d`, `rseed`, `rho`, `epk`, the
// clue.

import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { BABYJUB_SUBGROUP_ORDER, BN254_FR, POW_2_64 } from "./core/field.js";
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
import { buildDiversifiedKeys, deriveDiversifiedPk, deriveDkRoot } from "./keys/diversified.js";
import {
    deriveDiversifierKey,
    diversifierAt,
    diversifierIndex,
    diversifierToField,
} from "./keys/diversifier.js";
import { deriveOutgoingKey } from "./notes/outgoing.js";
import { deriveOutputSecret, expandSeed, seedFromSecret } from "./notes/seed.js";

const q = BABYJUB_SUBGROUP_ORDER;

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
                fc.record({
                    // Leaves room for the stranger account at `recipientNsk + 1`.
                    recipientNsk: fc.bigInt({ min: 1n, max: BN254_FR - 2n }),
                    senderNsk: fc.bigInt({ min: 1n, max: BN254_FR - 1n }),
                    index: fc.integer({ min: 0, max: 2 ** 32 - 1 }),
                    chainId: fc.bigInt({ min: 1n, max: POW_2_64 }),
                    rho: fc.bigInt({ min: 0n, max: BN254_FR - 1n }),
                    asset: fc.bigInt({ min: 0n, max: POW_2_64 - 1n }),
                    value: fc.bigInt({ min: 0n, max: POW_2_64 - 1n }),
                }),
                ({ recipientNsk, senderNsk, index, chainId, rho, asset, value }) => {
                    const ivk = deriveIvk(P, recipientNsk);

                    // The recipient publishes an address: (d, pk, pk_d, ck_d).
                    const dvk = deriveDiversifierKey(ivk);
                    const dBytes = diversifierAt(dvk, index);
                    const address = buildDiversifiedKeys(P, J, ivk, diversifierToField(dBytes));

                    // Sender: the address, the note and its own ock.
                    const gD = diversifiedBase(J, P, diversifierToField(dBytes));
                    const output = { chainId, rho, asset, value, d: dBytes, pk: address.pk };
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
});
