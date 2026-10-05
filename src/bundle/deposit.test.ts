import { beforeAll, describe, expect, it } from "vitest";
import { fieldToBytes32 } from "../core/hex.js";
import { randomBytes, randomJubjubScalar } from "../core/random.js";
import { buildInner, commitWithInner } from "../crypto/commit.js";
import { Jubjub } from "../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../crypto/poseidon.js";
import { InvalidArgumentError } from "../errors/config.js";
import { buildSpendingKey, type SpendingKey } from "../keys/keys.js";
import { deriveOutgoingKey } from "../notes/outgoing.js";
import { deriveDepositRho } from "../notes/seed.js";
import { emptyScanStats, type ScanInput, scanNotes } from "../sync/scan.js";
import { depositScanInputs, recipientAt } from "../test-utils/outputs.js";
import type { OutputRecipient } from "./common.js";
import { type BuiltDeposit, buildDeposit, type DepositArgs } from "./deposit.js";

const ASSET = 1n;
const FEE_ASSET = 2n;
const PAYER = "0x00000000000000000000000000000000000000aa";

describe("buildDeposit", () => {
    let P: Poseidon;
    let J: Jubjub;
    let depositor: SpendingKey;
    let relayer: SpendingKey;

    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
        depositor = buildSpendingKey(P, randomJubjubScalar());
        relayer = buildSpendingKey(P, randomJubjubScalar());
    });

    const addressOf = (key: SpendingKey, index = 0): OutputRecipient =>
        recipientAt(P, J, key, index);

    const args = (over: Partial<DepositArgs> = {}): DepositArgs => ({
        P,
        J,
        chainId: 31337n,
        asset: ASSET,
        payerAddress: PAYER,
        recipientAddress: PAYER,
        publicIn: 1_000n,
        recipient: addressOf(depositor, 4),
        outgoingKey: deriveOutgoingKey(depositor.nsk),
        rhoNonce: randomBytes(32),
        fee: {
            recipient: addressOf(relayer),
            value: 7n,
            asset: FEE_ASSET,
            rhoNonce: randomBytes(32),
        },
        ...over,
    });

    const leaves = (built: BuiltDeposit): ScanInput[] => depositScanInputs(P, J, built);

    it("mints two leaves, each of which scans for its recipient alone", () => {
        const a = args();
        const built = buildDeposit(a);
        const inputs = leaves(built);

        const mine = emptyScanStats();
        const myHits = scanNotes(J, P, depositor.ivk, inputs, mine);
        expect(myHits).toHaveLength(1);
        expect(myHits[0]).toMatchObject({
            asset: ASSET,
            value: 1_000n,
            d: a.recipient.d,
            cm: built.cm,
            leafIndex: 0,
        });
        expect(mine).toEqual({ ...emptyScanStats(), scanned: 2, notOurs: 1, hits: 1 });

        const theirs = emptyScanStats();
        const feeHits = scanNotes(J, P, relayer.ivk, inputs, theirs);
        expect(feeHits).toHaveLength(1);
        expect(feeHits[0]).toMatchObject({
            asset: FEE_ASSET,
            value: 7n,
            d: a.fee.recipient.d,
            leafIndex: 1,
        });
        expect(theirs).toEqual({ ...emptyScanStats(), scanned: 2, notOurs: 1, hits: 1 });
    });

    it("derives each leaf's rho from the outgoing key and that leaf's nonce", () => {
        const a = args();
        const built = buildDeposit(a);

        const [note] = built.producedNotes;
        expect(note.rho).toBe(deriveDepositRho(a.outgoingKey, a.rhoNonce));
        expect(note.pk).toBe(a.recipient.pk);
        expect(built.deposit.inner).toBe(fieldToBytes32(buildInner(P, note)));
        expect(built.cm).toBe(commitWithInner(P, ASSET, 1_000n, BigInt(built.deposit.inner)));

        const [feeHit] = scanNotes(J, P, relayer.ivk, leaves(built));
        expect(feeHit!.rho).toBe(deriveDepositRho(a.outgoingKey, a.fee.rhoNonce));
        expect(feeHit!.rho).not.toBe(note.rho);
    });

    it("is a function of its arguments, and of each nonce", () => {
        const a = args();
        const built = buildDeposit(a);

        expect(buildDeposit(a)).toEqual(built);

        const other = buildDeposit({ ...a, rhoNonce: randomBytes(32) });
        expect(other.deposit.inner).not.toBe(built.deposit.inner);
        expect(other.aux).not.toEqual(built.aux);
        expect(other.deposit.feeInner).toBe(built.deposit.feeInner);
        expect(other.feeAux).toEqual(built.feeAux);

        const otherFee = buildDeposit({ ...a, fee: { ...a.fee, rhoNonce: randomBytes(32) } });
        expect(otherFee.deposit.inner).toBe(built.deposit.inner);
        expect(otherFee.deposit.feeInner).not.toBe(built.deposit.feeInner);
    });

    it("defaults the fee note to the deposit's asset", () => {
        const a = args();
        const built = buildDeposit({ ...a, fee: { ...a.fee, asset: undefined } });

        expect(built.deposit.feeAssetId).toBe(ASSET);
        expect(scanNotes(J, P, relayer.ivk, leaves(built))[0]).toMatchObject({
            asset: ASSET,
            value: 7n,
        });
    });

    it("names asset 0 for a zero-value fee leaf, in the request and in the note", () => {
        const a = args();
        // Sealed to the depositor here, so its scan can open the leaf.
        const built = buildDeposit({
            ...a,
            fee: { ...a.fee, recipient: addressOf(depositor), value: 0n },
        });

        // The pool reverts `FeeAssetMustBeZero` for any other id on a zero-value leaf.
        expect(built.deposit.feeAssetId).toBe(0n);
        expect(built.deposit.feeIn).toBe(0n);

        // It opens for the depositor as a zero-value note and is not stored.
        const stats = emptyScanStats();
        const hits = scanNotes(J, P, depositor.ivk, leaves(built), stats);
        expect(hits.map((h) => h.leafIndex)).toEqual([0]);
        expect(stats).toEqual({ ...emptyScanStats(), scanned: 2, zeroValue: 1, hits: 1 });
    });

    it("refuses two leaves sharing a nonce, which would share a rho", () => {
        const a = args();
        const shared = { ...a, fee: { ...a.fee, rhoNonce: new Uint8Array(a.rhoNonce) } };

        expect(() => buildDeposit(shared)).toThrow(InvalidArgumentError);
        expect(() => buildDeposit(shared)).toThrow(/distinct rho nonces/);
    });

    it("refuses a key or a nonce that is not 32 bytes", () => {
        const a = args();
        const bad = [
            { ...a, outgoingKey: randomBytes(31) },
            { ...a, rhoNonce: randomBytes(16) },
            { ...a, fee: { ...a.fee, rhoNonce: randomBytes(33) } },
        ];
        for (const b of bad) expect(() => buildDeposit(b)).toThrow(InvalidArgumentError);
    });
});
