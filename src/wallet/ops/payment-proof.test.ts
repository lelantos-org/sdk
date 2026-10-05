import { TransactionReceiptNotFoundError, WaitForTransactionReceiptTimeoutError } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
    type PaymentProof,
    type PaymentProofReader,
    verifyPaymentProof,
} from "../../bundle/payment-proof.js";
import {
    NOTE_PAYLOAD_TOPIC,
    NULLIFIER_CONSUMED_TOPIC,
    ROOT_ADVANCED_TOPIC,
} from "../../chain/operation.js";
import type { PublishedNote, TxLog } from "../../chain/types.js";
import { ViemChainReader } from "../../chain/viem/reader.js";
import { circuitAmount, type EvmAddress, type Hex32 } from "../../core/brand.js";
import { BN254_FR } from "../../core/field.js";
import { bytesToHex, fieldToBytes32 } from "../../core/hex.js";
import { randomBytes, randomFr, randomJubjubScalar } from "../../core/random.js";
import { buildNoteCommitment } from "../../crypto/commit.js";
import { diversifiedBase } from "../../crypto/diversified-base.js";
import { Jubjub } from "../../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../../crypto/poseidon.js";
import { TxMiningError } from "../../errors/chain.js";
import { fmdFlagOnBase } from "../../fmd/clue.js";
import { fmdDiversifiedFlagKey } from "../../fmd/diversified.js";
import { type DecodedAddress, decodeAddress, encodeAddress } from "../../keys/address.js";
import { addressFromViewingKey } from "../../keys/keys.js";
import {
    clueBitsToPrefix,
    EMPTY_MEMO,
    encodeNotePayload,
    type NotePayload,
    withClueBitsPrefix,
} from "../../notes/codec.js";
import { encryptNote } from "../../notes/encrypt.js";
import { expandSeed, seedFromSecret } from "../../notes/seed.js";
import { TRANSACT_4X6 } from "../../protocol/shape.js";
import type { SubmitTransactPayload } from "../../protocol/transact.js";
import { makeTestCtx } from "../../test-utils/context.js";
import { estimateOf, freshAddress } from "../../test-utils/estimate.js";
import { freshAccount } from "../../test-utils/outputs.js";
import { storedNote } from "../../test-utils/wallet.js";
import { createPaymentProof, type PaymentProofTarget } from "./payment-proof.js";
import { executeTransfer } from "./transfer.js";

// A sender proves one payment to a third party who holds only the payee's address and reads only
// the chain. The stub chain serves what the pool would publish for the spend: its `NotePayload`
// logs, inside a transaction a relayer bundled with other spends.

const ASSET = 1n;
const CHAIN_ID = 31337n;
const TX = `0x${"7a".repeat(32)}` as Hex32;
const POOL = "0x2887cDe0763178e199A99289dbA9b46DB4d9DB2e" as EvmAddress;

const word = (n: bigint | number) => fieldToBytes32(BigInt(n));
const poolLog = (t0: Hex32, t1: Hex32): TxLog => ({ address: POOL, topics: [t0, t1] });

/** One spend's logs, as the pool emits them: nullifiers, the root, then one payload per output. */
function spendLogs(nullifiers: readonly bigint[], outCm: readonly bigint[]): TxLog[] {
    return [
        ...nullifiers.map((nf) => poolLog(NULLIFIER_CONSUMED_TOPIC, word(nf))),
        poolLog(ROOT_ADVANCED_TOPIC, word(0)),
        ...outCm.map((cm) => poolLog(NOTE_PAYLOAD_TOPIC, word(cm))),
    ];
}

/** Someone else's spend in the same transaction. */
const foreignSpend = (seed: number) =>
    spendLogs(
        [1, 2, 3, 4].map((i) => BigInt(seed + i)),
        [1, 2, 3, 4, 5, 6].map((i) => BigInt(seed + 0x100 + i)),
    );

/** The `NotePayload`s a submitted spend would emit, by commitment. */
function publishedBy(payload: SubmitTransactPayload): Map<string, PublishedNote> {
    return new Map(
        payload.pubInputs.outCm.map((cm, i) => {
            const hex = fieldToBytes32(cm);
            const { clueR, ephPub, ciphertext } = payload.aux[i]!;
            return [hex, { cm: hex, clueR, ephPub, ciphertext }];
        }),
    );
}

/** A reader over those logs, for the one transaction that carries them. */
function readerOver(published: Map<string, PublishedNote>, chainId = CHAIN_ID): PaymentProofReader {
    return {
        chainId: async () => chainId,
        fetchNotePayload: async (txHash, cm) =>
            txHash === TX ? (published.get(cm.toLowerCase()) ?? null) : null,
    };
}

/** Point the wallet's chain layer at `chain`. */
function setChain(ctx: { cfg: object }, chain: unknown): void {
    (ctx.cfg as { chain: unknown }).chain = chain;
}

/** How `createPaymentProof` refuses a commitment it cannot locate or reproduce. */
const NOT_REPRODUCED = { code: "INVALID_ARGUMENT", argument: "commitment" };

/** A reader serving `note` for every lookup. */
const readerOf = (note: PublishedNote): PaymentProofReader => ({
    chainId: async () => CHAIN_ID,
    fetchNotePayload: async () => note,
});

/**
 * A 30-unit transfer to the payee's address at `payeeIndex`, with a 7-unit relayer fee and
 * `memo` if given, as it would land: second of three spends in one transaction.
 */
async function paid(payeeIndex = 0, memo?: string) {
    const P = await Poseidon.build();
    const J = await Jubjub.build();
    const { keys: payeeKeys } = freshAccount(P, J);
    const payee = addressFromViewingKey(P, J, payeeKeys, payeeIndex);
    const relayer = await freshAddress();
    const made = await makeTestCtx({
        notes: [storedNote("01", 100n, { asset: ASSET })],
        shape: TRANSACT_4X6,
        estimate: estimateOf(relayer, { "1": 7n }),
    });
    made.submit.impl = async () => ({ txHash: TX });
    const result = await executeTransfer(made.ctx, {
        recipient: payee,
        amount: circuitAmount(30n),
        asset: ASSET,
        memo,
    });
    const payload = made.submitted.at(-1) as SubmitTransactPayload;
    const published = publishedBy(payload);
    const reader = readerOver(published);
    const logs = [
        ...foreignSpend(0x1000),
        ...spendLogs(payload.pubInputs.nullifier, payload.pubInputs.outCm),
        ...foreignSpend(0x2000),
    ];
    // The wallet's own chain layer reads the same transaction.
    const chain = {
        fetchNotePayload: reader.fetchNotePayload,
        txReceiptLogs: async (txHash: Hex32) => (txHash === TX ? logs : []),
        maspAddress: async () => POOL,
    };
    setChain(made.ctx, chain);
    const target: PaymentProofTarget = {
        txHash: result.txHash,
        commitment: result.recipientCommitment,
        recipient: payee,
        asset: ASSET,
        amount: 30n,
    };
    // The one valued output that is neither the payee's nor the wallet's own.
    const feeCommitment = result.nonZeroCommitments.find(
        (cm) => cm !== result.recipientCommitment && !result.ownCommitments.includes(cm),
    )!;
    const feeTarget: PaymentProofTarget = {
        txHash: result.txHash,
        commitment: feeCommitment,
        recipient: relayer,
        asset: ASSET,
        amount: 7n,
    };
    return {
        ...made,
        P,
        J,
        payeeKeys,
        payee,
        result,
        published,
        reader,
        chain,
        target,
        feeTarget,
    };
}

describe("payment proof", () => {
    it("shows a third party the asset and value one output paid the payee", async () => {
        const { ctx, payee, result, reader, target } = await paid();

        const proof = await createPaymentProof(ctx, target);

        expect(proof).toMatchObject({
            version: 3,
            chainId: "31337",
            txHash: TX,
            commitment: result.recipientCommitment,
            rho: expect.stringMatching(/^0x[0-9a-f]{64}$/),
            osk: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        });
        expect(Object.keys(proof).sort()).toEqual(
            ["chainId", "commitment", "osk", "rho", "txHash", "version"].sort(),
        );
        await expect(verifyPaymentProof({ proof, recipient: payee, reader })).resolves.toEqual({
            ok: true,
            asset: ASSET,
            value: 30n,
        });
    });

    it("needs the transfer's memo, and shows it to the verifier", async () => {
        const memo = "INV-2026-00418 · grazie";
        const { ctx, payee, reader, target } = await paid(0, memo);

        const proof = await createPaymentProof(ctx, { ...target, memo });
        await expect(verifyPaymentProof({ proof, recipient: payee, reader })).resolves.toEqual({
            ok: true,
            asset: ASSET,
            value: 30n,
            memo,
        });

        // The memo is part of what the output secret binds.
        for (const wrong of [undefined, "INV-2026-00419 · grazie"]) {
            await expect(createPaymentProof(ctx, { ...target, memo: wrong })).rejects.toThrow(
                /or carried a different memo/,
            );
        }
    });

    it("holds for a payee paid at a non-default address", async () => {
        const { ctx, P, J, payeeKeys, payee, reader, target } = await paid(11);
        const proof = await createPaymentProof(ctx, target);

        await expect(verifyPaymentProof({ proof, recipient: payee, reader })).resolves.toEqual({
            ok: true,
            asset: ASSET,
            value: 30n,
        });
        // Another address of the same payee is another base: the proof says nothing about it.
        const sibling = addressFromViewingKey(P, J, payeeKeys, 0);
        await expect(verifyPaymentProof({ proof, recipient: sibling, reader })).resolves.toEqual({
            ok: false,
            reason: "wrong-ephemeral",
        });
    });

    it("holds for any output of the spend: the relayer's fee", async () => {
        const { ctx, reader, feeTarget } = await paid();
        const proof = await createPaymentProof(ctx, feeTarget);

        await expect(
            verifyPaymentProof({ proof, recipient: feeTarget.recipient, reader }),
        ).resolves.toEqual({ ok: true, asset: ASSET, value: 7n });
    });

    it("survives JSON, so it can be sent as text", async () => {
        const { ctx, payee, reader, target } = await paid();
        const proof = await createPaymentProof(ctx, target);

        const received = JSON.parse(JSON.stringify(proof)) as PaymentProof;
        expect(received).toEqual(proof);
        await expect(
            verifyPaymentProof({ proof: received, recipient: payee, reader }),
        ).resolves.toEqual({ ok: true, asset: ASSET, value: 30n });
    });

    // Nothing is stored between the spend and the proof: a wallet restored from its seed on another
    // device recomputes the same secret.
    it("is recomputed from the seed, identically each time", async () => {
        const { ctx, target } = await paid();

        expect(await createPaymentProof(ctx, target)).toEqual(
            await createPaymentProof(ctx, target),
        );
    });

    it("opens only its own output: another's secret is refused", async () => {
        const { ctx, payee, reader, target, feeTarget } = await paid();
        const [mine, other] = await Promise.all([
            createPaymentProof(ctx, target),
            createPaymentProof(ctx, feeTarget),
        ]);
        expect(other.osk).not.toBe(mine.osk);
        expect(other.rho).not.toBe(mine.rho);

        const refused = { ok: false, reason: "wrong-ephemeral" };
        // The fee output's proof says nothing about the payee.
        await expect(
            verifyPaymentProof({ proof: other, recipient: payee, reader }),
        ).resolves.toEqual(refused);
        // Neither its secret nor its rho opens the payee's output.
        for (const proof of [
            { ...mine, osk: other.osk },
            { ...mine, rho: other.rho },
            { ...mine, osk: other.osk, rho: other.rho },
        ]) {
            await expect(verifyPaymentProof({ proof, recipient: payee, reader })).resolves.toEqual(
                refused,
            );
        }
    });

    it("is refused for an address on another base", async () => {
        const { ctx, reader, target } = await paid();
        const proof = await createPaymentProof(ctx, target);

        await expect(
            verifyPaymentProof({ proof, recipient: await freshAddress(), reader }),
        ).resolves.toEqual({ ok: false, reason: "wrong-ephemeral" });
    });

    it("is refused for an address that shares the base but not the key", async () => {
        const { ctx, J, payee, reader, target } = await paid();
        const proof = await createPaymentProof(ctx, target);
        const stranger = decodeAddress(J, await freshAddress());
        // Same `d`, so the ephemeral key matches; another `pk_d`, so the ciphertext does not open.
        const lookalike = encodeAddress(J, { ...decodeAddress(J, payee), pk_d: stranger.pk_d });

        await expect(verifyPaymentProof({ proof, recipient: lookalike, reader })).resolves.toEqual({
            ok: false,
            reason: "not-for-recipient",
        });
    });

    it("is refused under an address that shares the keys but not the pk", async () => {
        const { ctx, J, payee, reader, target } = await paid();
        const proof = await createPaymentProof(ctx, target);

        // The ciphertext opens, but the note it describes is not committed under this `pk`.
        const otherPk = encodeAddress(J, { ...decodeAddress(J, payee), pk: randomFr() });
        await expect(verifyPaymentProof({ proof, recipient: otherPk, reader })).resolves.toEqual({
            ok: false,
            reason: "commitment-mismatch",
        });
    });

    it("is refused on another chain, and for an output the pool never published", async () => {
        const { ctx, payee, published, target } = await paid();
        const proof = await createPaymentProof(ctx, target);

        await expect(
            verifyPaymentProof({ proof, recipient: payee, reader: readerOver(published, 1n) }),
        ).resolves.toEqual({ ok: false, reason: "wrong-chain" });
        await expect(
            verifyPaymentProof({ proof, recipient: payee, reader: readerOver(new Map()) }),
        ).resolves.toEqual({ ok: false, reason: "not-published" });
    });

    // The default reader, over a node that holds no receipt for the proof's transaction.
    it("is refused as not-published, at once, for a transaction the node does not know", async () => {
        const { ctx, payee, target } = await paid();
        const proof = await createPaymentProof(ctx, target);
        const reader = new ViemChainReader({
            rpcUrl: "http://rpc.test",
            maspAddress: POOL,
            chainId: CHAIN_ID,
        });
        const wait = vi.fn(async () => {
            throw new WaitForTransactionReceiptTimeoutError({ hash: TX });
        });
        Object.assign(reader.publicClient, {
            getTransactionReceipt: async () => {
                throw new TransactionReceiptNotFoundError({ hash: TX });
            },
            waitForTransactionReceipt: wait,
        });

        await expect(verifyPaymentProof({ proof, recipient: payee, reader })).resolves.toEqual({
            ok: false,
            reason: "not-published",
        });
        expect(wait).not.toHaveBeenCalled();
    });

    it("is refused when what the pool published is not what the proof opens", async () => {
        const { ctx, J, payee, result, published, target } = await paid();
        const proof = await createPaymentProof(ctx, target);
        const honest = published.get(result.recipientCommitment)!;
        const verdict = async (note: PublishedNote) => {
            const res = await verifyPaymentProof({
                proof,
                recipient: payee,
                reader: readerOf(note),
            });
            return res.ok ? "ok" : res.reason;
        };
        const flipped = (bytes: Uint8Array, at: number) => {
            const out = new Uint8Array(bytes);
            out[at]! ^= 1;
            return out;
        };
        const otherPoint = J.mulPointEscalar(J.base8, randomJubjubScalar());

        expect(await verdict(honest)).toBe("ok");
        expect(await verdict({ ...honest, ephPub: otherPoint })).toBe("wrong-ephemeral");
        // Not a curve point at all.
        expect(await verdict({ ...honest, ephPub: [1n, 2n] })).toBe("wrong-ephemeral");
        expect(await verdict({ ...honest, cm: fieldToBytes32(randomFr()) })).toBe(
            "commitment-mismatch",
        );
        expect(await verdict({ ...honest, clueR: otherPoint })).toBe("wrong-clue");
        expect(await verdict({ ...honest, clueR: [1n, 2n] })).toBe("wrong-clue");
        // The clue bits are the ciphertext's two-byte prefix, outside the AEAD.
        expect(await verdict({ ...honest, ciphertext: flipped(honest.ciphertext, 1) })).toBe(
            "wrong-clue",
        );
        // The body is authenticated: with a changed byte it does not open.
        expect(await verdict({ ...honest, ciphertext: flipped(honest.ciphertext, 2) })).toBe(
            "not-for-recipient",
        );
        expect(await verdict({ ...honest, ciphertext: honest.ciphertext.subarray(0, 1) })).toBe(
            "not-for-recipient",
        );
    });

    it("refuses anything that is not a well-formed version-3 proof", async () => {
        const { ctx, payee, reader, target } = await paid();
        const proof = await createPaymentProof(ctx, target);
        const { osk: _osk, ...noSecret } = proof;
        const { rho: _rho, ...noRho } = proof;

        for (const bad of [
            { ...proof, version: 2 },
            { ...proof, version: 4 },
            { ...proof, version: "3" },
            // An ephemeral secret in place of `rho` and `osk`.
            { ...noSecret, version: 1, esk: proof.osk, rho: undefined },
            noSecret,
            noRho,
            { ...proof, osk: "0x00" },
            { ...proof, osk: proof.osk.slice(2) },
            { ...proof, osk: 5 },
            { ...proof, rho: "0x00" },
            // Not a canonical field element.
            { ...proof, rho: fieldToBytes32(BN254_FR) },
            { ...proof, rho: `0x${"ff".repeat(32)}` },
            { ...proof, chainId: "0x7a69" },
            { ...proof, chainId: 31337 },
            { ...proof, txHash: "0x7a" },
            { ...proof, commitment: null },
            null,
            undefined,
            "proof",
            [],
        ]) {
            await expect(
                verifyPaymentProof({ proof: bad as never, recipient: payee, reader }),
            ).resolves.toEqual({ ok: false, reason: "malformed" });
        }
    });

    it("throws for a recipient that is not an address, or a reader without logs", async () => {
        const { ctx, payee, target } = await paid();
        const proof = await createPaymentProof(ctx, target);

        await expect(
            verifyPaymentProof({
                proof,
                recipient: "lelantos1nope",
                reader: readerOver(new Map()),
            }),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", argument: "address" });
        await expect(
            verifyPaymentProof({ proof, recipient: payee, reader: { chainId: async () => 1n } }),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", argument: "reader" });
    });
});

// Outputs no honest wallet makes: the verifier must name what is wrong with each.
describe("payment proof, against a dishonest sender", () => {
    interface Forgery {
        /** The plaintext sealed in place of the honest one. */
        plaintext?: (honest: NotePayload) => Uint8Array;
        /** The clue blinder used in place of the seed's. */
        fmdR?: bigint;
        /** What the output pays, committed and sealed consistently. Default: 30 of `ASSET`. */
        asset?: bigint;
        value?: bigint;
    }

    async function forge(over: Forgery = {}) {
        const P = await Poseidon.build();
        const J = await Jubjub.build();
        const address = addressFromViewingKey(P, J, freshAccount(P, J).keys, 2);
        const recipient: DecodedAddress = decodeAddress(J, address);

        const osk = randomBytes(32);
        const rho = randomFr();
        const rseed = seedFromSecret(osk);
        const { rcm, esk, fmdR } = expandSeed(rseed, rho);
        const gD = diversifiedBase(J, P, recipient.d);
        const asset = over.asset ?? ASSET;
        const value = over.value ?? 30n;
        const honest: NotePayload = {
            asset,
            value,
            rho,
            rseed,
            d: recipient.d,
            memo: EMPTY_MEMO,
        };
        const enc = encryptNote({
            J,
            gD,
            recipientPkD: recipient.pk_d,
            esk,
            plaintext: over.plaintext?.(honest) ?? encodeNotePayload(honest),
        });
        const clue = fmdFlagOnBase(
            J,
            P,
            fmdDiversifiedFlagKey(J, P, recipient.ck_d, gD),
            gD,
            over.fmdR ?? fmdR,
        );
        const cm = fieldToBytes32(
            buildNoteCommitment(P, { asset, value, pk: recipient.pk, rho, rcm }),
        );
        const published: PublishedNote = {
            cm,
            clueR: J.unpackPoint(clue.R)!,
            ephPub: J.unpackPoint(enc.epk)!,
            ciphertext: withClueBitsPrefix(clueBitsToPrefix(clue.bits, clue.gamma), enc.ciphertext),
        };
        const proof: PaymentProof = {
            version: 3,
            chainId: CHAIN_ID.toString(),
            txHash: TX,
            commitment: cm,
            rho: fieldToBytes32(rho),
            osk: bytesToHex(osk) as Hex32,
        };
        const res = await verifyPaymentProof({
            proof,
            recipient: address,
            reader: readerOf(published),
        });
        return res.ok ? "ok" : res.reason;
    }

    it("accepts the output an honest sender would have made", async () => {
        expect(await forge()).toBe("ok");
    });

    it("names a plaintext addressed to another diversifier", async () => {
        const plaintext = (p: NotePayload) => encodeNotePayload({ ...p, d: p.d ^ 1n });
        expect(await forge({ plaintext })).toBe("not-for-recipient");
    });

    it("names a plaintext that does not open the commitment", async () => {
        const cases: ((p: NotePayload) => Uint8Array)[] = [
            (p) => encodeNotePayload({ ...p, rseed: randomBytes(32) }),
            (p) => encodeNotePayload({ ...p, rho: randomFr() }),
            (p) => encodeNotePayload({ ...p, value: p.value + 1n }),
            (p) => encodeNotePayload({ ...p, asset: p.asset + 1n }),
            // Authenticated, but not a note payload.
            (p) => encodeNotePayload(p).subarray(0, 96),
        ];
        for (const plaintext of cases) {
            expect(await forge({ plaintext })).toBe("commitment-mismatch");
        }
    });

    // Every other check passes: the output opens its commitment under the payee's keys. The
    // payee's scanner still discards it, so it paid nothing.
    it("names an output that carries no value", async () => {
        expect(await forge({ value: 0n })).toBe("no-value");
        expect(await forge({ asset: 0n })).toBe("no-value");
        expect(await forge({ asset: 0n, value: 0n })).toBe("no-value");
        expect(await forge({ value: 1n })).toBe("ok");
    });

    it("names a clue made with another blinder", async () => {
        expect(await forge({ fmdR: randomJubjubScalar() })).toBe("wrong-clue");
    });
});

describe("createPaymentProof", () => {
    it("cannot be produced by a wallet that did not make the output", async () => {
        const { chain, target } = await paid();
        const { ctx: stranger } = await makeTestCtx({ chain });

        await expect(createPaymentProof(stranger, target)).rejects.toMatchObject(NOT_REPRODUCED);
    });

    it("refuses a recipient, asset or amount the output did not pay", async () => {
        const { ctx, P, J, payeeKeys, payee, target } = await paid();
        const paidTo = decodeAddress(J, payee);
        const stranger = decodeAddress(J, await freshAddress());

        for (const wrong of [
            { recipient: await freshAddress() },
            { recipient: addressFromViewingKey(P, J, payeeKeys, 1) },
            // The payee's `d` and `pk`, so the same base and commitment key, under another point.
            { recipient: encodeAddress(J, { ...paidTo, pk_d: stranger.pk_d }) },
            { recipient: encodeAddress(J, { ...paidTo, ck_d: stranger.ck_d }) },
            { asset: 2n },
            { amount: 31n },
        ]) {
            await expect(createPaymentProof(ctx, { ...target, ...wrong })).rejects.toMatchObject(
                NOT_REPRODUCED,
            );
        }
    });

    it("reads the nullifiers and the slot from the output's own spend in a bundled transaction", async () => {
        const { ctx, chain, payee, reader, submitted, target } = await paid();
        const bundled = await createPaymentProof(ctx, target);
        await expect(
            verifyPaymentProof({ proof: bundled, recipient: payee, reader }),
        ).resolves.toMatchObject({ ok: true });

        // The same spend landed alone gives the same proof: the other spends' nullifiers and
        // payloads contribute nothing.
        const { pubInputs } = submitted.at(-1) as SubmitTransactPayload;
        setChain(ctx, {
            ...chain,
            txReceiptLogs: async () => spendLogs(pubInputs.nullifier, pubInputs.outCm),
        });
        expect(await createPaymentProof(ctx, target)).toEqual(bundled);

        // A slot counted across the transaction, or another spend's nullifier, names another
        // note and reproduces no output of this wallet.
        setChain(ctx, {
            ...chain,
            txReceiptLogs: async () =>
                spendLogs(pubInputs.nullifier, [0xdead0n, ...pubInputs.outCm]),
        });
        await expect(createPaymentProof(ctx, target)).rejects.toMatchObject(NOT_REPRODUCED);
        setChain(ctx, {
            ...chain,
            txReceiptLogs: async () =>
                spendLogs([0xdead1n, ...pubInputs.nullifier.slice(1)], pubInputs.outCm),
        });
        await expect(createPaymentProof(ctx, target)).rejects.toMatchObject(NOT_REPRODUCED);
    });

    // The output secret binds every nullifier of the spend in slot order, the dummy slots' too,
    // so the wallet must read them all from the receipt, and only its own spend's.
    it("binds every nullifier of the spend, for an output past slot 0", async () => {
        const { ctx, chain, reader, submitted, target, feeTarget } = await paid();
        const { pubInputs } = submitted.at(-1) as SubmitTransactPayload;
        const slotOf = (t: PaymentProofTarget) =>
            pubInputs.outCm.findIndex((cm) => fieldToBytes32(cm) === t.commitment);
        // The payee's and the relayer's outputs cannot both sit at slot 0.
        const proven = slotOf(target) > 0 ? target : feeTarget;
        expect(slotOf(proven)).toBeGreaterThan(0);

        const proof = await createPaymentProof(ctx, proven);
        await expect(
            verifyPaymentProof({ proof, recipient: proven.recipient, reader }),
        ).resolves.toEqual({ ok: true, asset: ASSET, value: proven.amount });

        const nf = pubInputs.nullifier as [bigint, bigint, bigint, bigint];
        expect(nf).toHaveLength(4);
        for (const altered of [
            // The last slot is a dummy: `rho` does not depend on it.
            [nf[0], nf[1], nf[2], 0xdead1n],
            [nf[0], 0xdead2n, nf[2], nf[3]],
            // The same nullifiers, in another order after the first.
            [nf[0], nf[2], nf[1], nf[3]],
            [nf[0], nf[1], nf[2]],
            [nf[0], nf[1], nf[2], nf[3], 0xdead3n],
        ]) {
            setChain(ctx, {
                ...chain,
                txReceiptLogs: async () => [
                    ...foreignSpend(0x1000),
                    ...spendLogs(altered, pubInputs.outCm),
                    ...foreignSpend(0x2000),
                ],
            });
            await expect(createPaymentProof(ctx, proven)).rejects.toMatchObject(NOT_REPRODUCED);
        }
    });

    it("rejects a commitment the transaction does not carry", async () => {
        const { ctx, chain, target } = await paid();

        await expect(
            createPaymentProof(ctx, { ...target, commitment: `0x${"00".repeat(32)}` }),
        ).rejects.toMatchObject(NOT_REPRODUCED);

        // Published, but the receipt shows no spend around it.
        setChain(ctx, { ...chain, txReceiptLogs: async () => [] });
        await expect(createPaymentProof(ctx, target)).rejects.toMatchObject(NOT_REPRODUCED);
    });

    // `fetchNotePayload` answers `null` for a transaction the node does not know, where
    // `txReceiptLogs` waits for its receipt and then rejects.
    it("rejects a transaction the chain does not know, without waiting on its logs", async () => {
        const { ctx, chain, target } = await paid();
        const txReceiptLogs = vi.fn(async () => {
            throw new TxMiningError("txReceiptLogs: transaction receipt did not arrive in time");
        });
        setChain(ctx, { ...chain, fetchNotePayload: async () => null, txReceiptLogs });

        await expect(
            createPaymentProof(ctx, { ...target, txHash: `0x${"ee".repeat(32)}` }),
        ).rejects.toMatchObject(NOT_REPRODUCED);
        expect(txReceiptLogs).not.toHaveBeenCalled();
    });

    it("rejects a malformed target before reading the chain", async () => {
        const { ctx, target } = await paid();
        let reads = 0;
        setChain(ctx, {
            fetchNotePayload: async () => {
                reads++;
                return null;
            },
            txReceiptLogs: async () => {
                reads++;
                return [];
            },
            maspAddress: async () => POOL,
        });

        for (const [bad, argument] of [
            [{ txHash: "0x7a" }, "hex32"],
            [{ commitment: "nope" }, "hex32"],
            [{ recipient: "lelantos1nope" }, "address"],
            [{ recipient: 5 }, "recipient"],
            [{ asset: 1 }, "asset"],
            [{ asset: -1n }, "asset"],
            [{ amount: "30" }, "amount"],
            [{ amount: -1n }, "amount"],
        ] as const) {
            await expect(
                createPaymentProof(ctx, { ...target, ...bad } as never),
            ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", argument });
        }
        expect(reads).toBe(0);
    });

    it("needs a chain layer that reads note payloads and receipt logs", async () => {
        const { ctx, chain, target } = await paid();
        const { fetchNotePayload, txReceiptLogs, maspAddress } = chain;

        for (const [layer, missing] of [
            [{ txReceiptLogs, maspAddress }, ["chain.fetchNotePayload"]],
            [{ fetchNotePayload, maspAddress }, ["chain.txReceiptLogs"]],
            [{ maspAddress }, ["chain.fetchNotePayload", "chain.txReceiptLogs"]],
        ] as const) {
            setChain(ctx, layer);
            await expect(createPaymentProof(ctx, target)).rejects.toMatchObject({
                code: "UNSUPPORTED_OPERATION",
                missing,
            });
        }
    });
});
