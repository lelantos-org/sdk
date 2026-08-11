import { describe, expect, it } from "vitest";
import { randomFr, randomJubjubScalar } from "../core/random.js";
import type { Jubjub } from "../crypto/jubjub.js";
import { WasmJubjub } from "../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../crypto/poseidon.js";
import type { Note } from "../notes/note.js";
import type { SpendKind } from "../protocol/transact.js";
import type { Prover } from "../prover/types.js";
import type { InputSlot } from "./common.js";
import { buildSpend, type SpendArgs } from "./spend.js";

// `kind` routes the on-chain call: a transfer tagged `withdrawNative` would
// reach MASP.withdrawNative and unwrap WETH to a recipient. It is a plain
// argument to the shared builder, so each kind is asserted here.

/** Records the witness instead of proving; proving is minutes and 36 MB. */
function recordingProver(): Prover & { last?: Record<string, unknown> } {
    const p: Prover & { last?: Record<string, unknown> } = {
        async prove(input) {
            p.last = input;
            return {
                proof: {
                    pi_a: ["1", "2"],
                    pi_b: [["3", "4"]],
                    pi_c: ["5", "6"],
                    protocol: "groth16",
                    curve: "bn128",
                },
                publicSignals: [],
            };
        },
    };
    return p;
}

function note(_J: Jubjub, value: bigint, pk: bigint): Note {
    return {
        asset: 1n,
        value,
        pk,
        rho: randomFr(),
        rcm: randomFr(),
        rcv: randomJubjubScalar(),
        rcvDep: randomJubjubScalar(),
    };
}

describe("buildSpend", () => {
    it("tags the payload with the kind it was given", async () => {
        const P = await Poseidon.build();
        const J = await WasmJubjub.build();
        const pk = randomFr();
        const dk = randomFr();
        const pkD = J.mulPointEscalar(J.base8, randomJubjubScalar());
        const recipient = { pk_d: pkD, dk, pk };

        const treeDepth = 4;
        const input: InputSlot = {
            cached: {
                note: note(J, 100n, pk),
                nsk: randomJubjubScalar(),
                leafIndex: 0,
            },
            pathElements: Array.from({ length: treeDepth }, () => [0n, 0n, 0n]),
            pathIndices: Array.from({ length: treeDepth }, () => 0),
        };

        const base = (kind: SpendKind, publicOut: bigint, outs: [Note, Note]): SpendArgs => ({
            P,
            J,
            kind,
            chainId: 31337n,
            asset: 1n,
            payerAddress: "0x0000000000000000000000000000000000000000",
            relayerAddress: "0x0000000000000000000000000000000000000000",
            recipientAddress: "0x0000000000000000000000000000000000000000",
            prover: recordingProver(),
            treeDepth,
            inputs: [input, null],
            merkleRoot: 0n,
            outputs: outs,
            outputRecipients: [recipient, recipient],
            outputRandomness: [
                { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
                { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
            ],
            publicOut,
        });

        for (const kind of ["transfer", "withdraw", "withdrawNative"] as SpendKind[]) {
            const publicOut = kind === "transfer" ? 0n : 40n;
            const outs: [Note, Note] = [note(J, 100n - publicOut, pk), note(J, 0n, pk)];
            const built = await buildSpend(base(kind, publicOut, outs));

            expect(built.payload.kind).toBe(kind);
            expect(built.payload.pubInputs.publicOut).toBe(publicOut);
            expect(built.payload.pubInputs.publicIn).toBe(0n);
            expect(built.cm).toHaveLength(2);
            expect(built.payload.aux).toHaveLength(2);
        }
    });

    it("rejects an unbalanced spend, naming the kind", async () => {
        const P = await Poseidon.build();
        const J = await WasmJubjub.build();
        const pk = randomFr();
        const pkD = J.mulPointEscalar(J.base8, randomJubjubScalar());
        const recipient = { pk_d: pkD, dk: randomFr(), pk };

        const args: SpendArgs = {
            P,
            J,
            kind: "withdraw",
            chainId: 31337n,
            asset: 1n,
            payerAddress: "0x0000000000000000000000000000000000000000",
            relayerAddress: "0x0000000000000000000000000000000000000000",
            recipientAddress: "0x0000000000000000000000000000000000000000",
            prover: recordingProver(),
            treeDepth: 4,
            inputs: [
                {
                    cached: { note: note(J, 100n, pk), nsk: randomJubjubScalar(), leafIndex: 0 },
                    pathElements: Array.from({ length: 4 }, () => [0n, 0n, 0n]),
                    pathIndices: [0, 0, 0, 0],
                },
                null,
            ],
            merkleRoot: 0n,
            outputs: [note(J, 90n, pk), note(J, 0n, pk)],
            outputRecipients: [recipient, recipient],
            outputRandomness: [
                { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
                { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
            ],
            publicOut: 40n, // 90 + 40 != 100
        };

        await expect(buildSpend(args)).rejects.toThrow(/withdraw balance/);
    });

    it("requires at least one real input", async () => {
        const P = await Poseidon.build();
        const J = await WasmJubjub.build();
        const pk = randomFr();
        const pkD = J.mulPointEscalar(J.base8, randomJubjubScalar());
        const recipient = { pk_d: pkD, dk: randomFr(), pk };

        await expect(
            buildSpend({
                P,
                J,
                kind: "transfer",
                chainId: 31337n,
                asset: 1n,
                payerAddress: "0x0000000000000000000000000000000000000000",
                relayerAddress: "0x0000000000000000000000000000000000000000",
                recipientAddress: "0x0000000000000000000000000000000000000000",
                prover: recordingProver(),
                treeDepth: 4,
                inputs: [null, null],
                merkleRoot: 0n,
                outputs: [note(J, 0n, pk), note(J, 0n, pk)],
                outputRecipients: [recipient, recipient],
                outputRandomness: [
                    { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
                    { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
                ],
            }),
        ).rejects.toThrow(/transfer: at least one real input/);
    });
});
