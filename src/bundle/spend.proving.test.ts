// End-to-end: a spend `buildSpend` assembles proves against the shipped 4×6
// circuit, and the payload it returns reproduces the proof's public signals
// the way the pool does, from calldata alone.
//
// `spend.test.ts` records the witness instead of proving it, so nothing there
// notices a witness the circuit rejects: a transfer naming an asset, a pad
// output under asset 0, a dummy input whose nullifier does not open, an input
// whose `pk` does not open under its `nsk` and diversifier.
//
// Skipped when the companion package's artifacts are absent.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { coeffs, fiatShamirZ, flatten, hornerEval } from "../circuit/compression.js";
import { randomFr, randomJubjubScalar } from "../core/random.js";
import { buildNoteCommitment } from "../crypto/commit.js";
import { Jubjub } from "../crypto/jubjub-wasm/index.js";
import { MerkleTree } from "../crypto/merkle.js";
import { Poseidon } from "../crypto/poseidon.js";
import { TAG_PK } from "../crypto/tags.js";
import { defaultDiversifier } from "../keys/diversifier.js";
import { buildSpendingKey, type SpendingKey } from "../keys/keys.js";
import type { Note } from "../notes/note.js";
import { freshNoteRandomness, freshOutputAuxRandomness } from "../notes/randomness.js";
import { auxDigest } from "../protocol/abi-hash.js";
import { auxOutputToWire } from "../protocol/aux-wire.js";
import { TRANSACT_4X6 } from "../protocol/shape.js";
import type { SpendKind, SubmitTransactPayload } from "../protocol/transact.js";
import { prove, verify } from "../prover/snarkjs.js";
import type { ProveResult, Prover, ProverPaths } from "../prover/types.js";
import type { InputSlot } from "./common.js";
import { buildSpend } from "./spend.js";

/** Depth of `4x6.circom`'s tree: `Transact(11, 4, 6)`. */
const DEPTH = 11;
const ASSET = 1n;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const RELAYER = "0x00000000000000000000000000000000000000b0";
const PAYEE = "0x00000000000000000000000000000000000000fe";

function packageFile(subpath: string): string | null {
    try {
        const href = (import.meta as { resolve?: (s: string) => string }).resolve?.(
            `@lelantos-org/circuits/${subpath}`,
        );
        const path = href ? fileURLToPath(href) : null;
        return path && existsSync(path) ? path : null;
    } catch {
        return null;
    }
}

const wasmPath = packageFile("4x6/4x6.wasm");
const zkeyPath = packageFile("4x6/4x6_final.zkey");
const vkeyPath = packageFile("4x6/verification_key.json");
const paths: ProverPaths | null = wasmPath && zkeyPath ? { wasmPath, zkeyPath } : null;

/** Proves for real and keeps the result, which `buildSpend` reduces to the proof. */
function keepingProver(p: ProverPaths): Prover & { last?: ProveResult } {
    const prover: Prover & { last?: ProveResult } = {
        async prove(input) {
            prover.last = await prove(input, p);
            return prover.last;
        },
    };
    return prover;
}

/**
 * `(y, digest, z)` as `PubInputs.compress(Transact)` derives them: the clue
 * words from `aux`, the clue bits from each ciphertext's big-endian `uint16`
 * prefix, and `digest` taken from calldata.
 */
function compressedByPool(payload: SubmitTransactPayload): string[] {
    const pi = payload.pubInputs;
    const input = {
        merkle_root: pi.merkleRoot,
        nullifier: pi.nullifier,
        out_cm: pi.outCm,
        public_asset_id: pi.publicAssetId,
        public_out: pi.publicOut,
        digest: pi.digest,
        recipient_address: BigInt(pi.recipient),
        chain_id: pi.chainId,
        payer_address: BigInt(pi.payer),
        relayer_address: BigInt(pi.relayer),
        intent_hash: pi.intentHash,
        out_clue_Rx: payload.aux.map((a) => a.clueR[0]),
        out_clue_Ry: payload.aux.map((a) => a.clueR[1]),
        out_clue_bits: payload.aux.map((a) =>
            BigInt(((a.ciphertext[0] as number) << 8) | (a.ciphertext[1] as number)),
        ),
        out_aux_digest: auxDigest(payload.aux.map(auxOutputToWire)),
    };
    const z = fiatShamirZ(flatten(input));
    return [hornerEval(coeffs(input), z), pi.digest, z].map(String);
}

describe.skipIf(!paths || !vkeyPath)("buildSpend against the 4x6 circuit", () => {
    /**
     * `opening` replaces what the spent note is committed under (`pk`) and what the witness
     * opens it with (`d`); the default is the spender's own `pk` and default diversifier.
     */
    async function spend(
        kind: SpendKind,
        publicOut: bigint,
        opening?: (P: Poseidon, me: SpendingKey) => { pk: bigint; d: bigint },
    ) {
        const P = await Poseidon.build();
        const J = await Jubjub.build();
        const me = buildSpendingKey(P, J, randomJubjubScalar());
        const payee = buildSpendingKey(P, J, randomJubjubScalar());
        const { pk, d } = opening?.(P, me) ?? { pk: me.pk, d: defaultDiversifier(me.ivk) };

        // One note in a tree that also holds unrelated leaves.
        const spent: Note = { asset: ASSET, value: 100n, pk, ...freshNoteRandomness() };
        const tree = new MerkleTree(P, DEPTH);
        tree.bulkInsert([randomFr(), randomFr(), buildNoteCommitment(P, spent), randomFr()]);
        const leafIndex = 2;
        const input: InputSlot = {
            cached: { note: spent, nsk: me.nsk, d, leafIndex },
            ...tree.proof(leafIndex),
        };

        // The payee's note first, then pads to self: zero-value, in the spend asset.
        const pad = (): Note => ({ asset: ASSET, value: 0n, pk: me.pk, ...freshNoteRandomness() });
        const sent = 100n - publicOut;
        const outputs: Note[] = [
            { asset: ASSET, value: sent, pk: payee.pk, ...freshNoteRandomness() },
            ...Array.from({ length: TRANSACT_4X6.nOut - 1 }, pad),
        ];

        const prover = keepingProver(paths as ProverPaths);
        const built = await buildSpend({
            P,
            J,
            kind,
            chainId: 31337n,
            asset: ASSET,
            payerAddress: ZERO_ADDR,
            relayerAddress: RELAYER,
            recipientAddress: publicOut === 0n ? ZERO_ADDR : PAYEE,
            prover,
            treeDepth: DEPTH,
            shape: TRANSACT_4X6,
            inputs: [input, null, null, null],
            merkleRoot: tree.root(),
            outputs,
            outputRecipients: [payee, ...outputs.slice(1).map(() => me)],
            outputRandomness: outputs.map(() => freshOutputAuxRandomness()),
            publicOut,
        });
        return { built, proved: prover.last as ProveResult };
    }

    async function expectVerifies({ built, proved }: Awaited<ReturnType<typeof spend>>) {
        const vkey = JSON.parse(readFileSync(vkeyPath as string, "utf8")) as object;
        expect(await verify(vkey, proved.publicSignals, proved.proof)).toBe(true);
        // What the pool hands the verifier is what the circuit emitted.
        expect(compressedByPool(built.payload)).toEqual(proved.publicSignals);
    }

    it("proves a transfer, which names no asset", async () => {
        const made = await spend("transfer", 0n);

        expect(made.built.payload.pubInputs.publicAssetId).toBe(0n);
        expect(made.built.payload.pubInputs.publicOut).toBe(0n);
        await expectVerifies(made);
    }, 120_000);

    it("proves a withdraw, which names the asset leaving the pool", async () => {
        const made = await spend("withdraw", 40n);

        expect(made.built.payload.pubInputs.publicAssetId).toBe(ASSET);
        expect(made.built.payload.pubInputs.publicOut).toBe(40n);
        await expectVerifies(made);
    }, 120_000);

    // SpentNote derives the slot's pk from `nsk` and `in_d` and opens the commitment under it, so
    // a note committed under any other key is not in the tree: witness generation fails before
    // any proving.
    it("rejects an input opened under a diversifier its pk was not derived with", async () => {
        const d0 = (me: SpendingKey) => defaultDiversifier(me.ivk);

        await expect(
            spend("transfer", 0n, (_P, me) => ({ pk: me.pk, d: d0(me) + 1n })),
        ).rejects.toThrow(/Assert Failed/);
        await expect(spend("transfer", 0n, (_P, me) => ({ pk: me.pk, d: 0n }))).rejects.toThrow(
            /Assert Failed/,
        );
    }, 120_000);

    it("rejects a note committed under the arity-2 pk, whatever diversifier opens it", async () => {
        const arity2 = (P: Poseidon, me: SpendingKey) => P.hash([TAG_PK, me.ivk]);

        await expect(
            spend("transfer", 0n, (P, me) => ({
                pk: arity2(P, me),
                d: defaultDiversifier(me.ivk),
            })),
        ).rejects.toThrow(/Assert Failed/);
        await expect(
            spend("transfer", 0n, (P, me) => ({ pk: arity2(P, me), d: 0n })),
        ).rejects.toThrow(/Assert Failed/);
    }, 120_000);
});
