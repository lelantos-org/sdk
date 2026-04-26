import { describe, expect, it } from "vitest";
import { randomFr } from "../core/random.js";
import { WasmJubjub } from "../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../crypto/poseidon.js";
import { dummyInputAt } from "./spent-note.js";

// `in_cv` is a public input (PI slots 8..11, `PubInputs.compress`), so anything
// deterministic about a dummy slot's commitment is visible on chain. With
// rcv = 0 and value = 0 the commitment is the identity point in every
// transaction, which is a free "this slot is a dummy" oracle.

const cvOf = (J: WasmJubjub, asset: bigint, value: bigint, rcv: bigint) =>
    J.valueCommit(value, J.hashToAssetGen(asset), rcv);

describe("dummyInputAt", () => {
    it("blinds the value commitment so the slot is not identifiable", async () => {
        const P = await Poseidon.build();
        const J = await WasmJubjub.build();

        const a = dummyInputAt(P, 4, randomFr());
        const b = dummyInputAt(P, 4, randomFr());

        const cvA = cvOf(J, a.asset, a.value, a.rcv);
        const cvB = cvOf(J, b.asset, b.value, b.rcv);

        // Identity is what an unblinded zero-value commitment collapses to.
        expect(cvA).not.toEqual([0n, 1n]);
        expect(cvB).not.toEqual([0n, 1n]);
        expect(cvA).not.toEqual(cvB);

        expect(a.rcv).not.toBe(0n);
        expect(a.rcvDep).not.toBe(0n);
    });

    it("gives every dummy a distinct nullifier", async () => {
        const P = await Poseidon.build();

        const a = dummyInputAt(P, 4, randomFr());
        const b = dummyInputAt(P, 4, randomFr());

        expect(a.nf).not.toBe(b.nf);
        expect(a.isDummy).toBe(true);
    });

    it("honours explicit blinders for fixtures", async () => {
        const P = await Poseidon.build();

        const d = dummyInputAt(P, 4, 7n, { rcv: 11n, rcvDep: 13n });

        expect(d.rho).toBe(7n);
        expect(d.rcv).toBe(11n);
        expect(d.rcvDep).toBe(13n);
        // Same inputs reproduce the same slot, byte for byte.
        expect(dummyInputAt(P, 4, 7n, { rcv: 11n, rcvDep: 13n })).toEqual(d);
    });
});
