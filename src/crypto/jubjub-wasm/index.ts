// WASM-backed Baby-Jubjub. Wire conventions: `sdk/wasm/jubjub/src/lib.rs`.

import { FIELD_BYTES, fromLeBytes, toLeBytes } from "../../core/bytes.js";
import type { Point } from "../jubjub.js";
import type { Field } from "../poseidon.js";
import { ensureInit, w } from "./loader.js";
import { bytesToPoint, pointToBytes } from "./point-codec.js";

export { configureJubjubWasm, type JubjubWasmLoader } from "./loader.js";

/** @internal */
export class Jubjub {
    private constructor(
        readonly base8: Point,
        readonly order: bigint,
    ) {}

    static async build(): Promise<Jubjub> {
        await ensureInit();
        const base8 = bytesToPoint(w().base8());
        const order = fromLeBytes(w().sub_order_le());
        return new Jubjub(base8, order);
    }

    addPoint(a: Point, b: Point): Point {
        const out = w().add_point(pointToBytes(a), pointToBytes(b));
        return bytesToPoint(out);
    }

    mulPointEscalar(p: Point, scalar: Field): Point {
        const out = w().mul_point_escalar(
            pointToBytes(p),
            toLeBytes(scalar % this.order, FIELD_BYTES),
        );
        return bytesToPoint(out);
    }

    inSubgroup(p: Point): boolean {
        return w().in_subgroup(pointToBytes(p));
    }

    packPoint(p: Point): Uint8Array {
        return new Uint8Array(w().pack_point(pointToBytes(p)));
    }

    unpackPoint(buf: Uint8Array): Point | null {
        const out = w().unpack_point(buf);
        return out ? bytesToPoint(out) : null;
    }

    tryDecryptNote(ivk: Field, epkPacked: Uint8Array, ciphertext: Uint8Array): Uint8Array | null {
        const out = w().try_decrypt_note(
            toLeBytes(ivk % this.order, FIELD_BYTES),
            epkPacked,
            ciphertext,
        );
        return out ? new Uint8Array(out) : null;
    }
}
