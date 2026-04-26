// WASM-backed Baby-Jubjub — the sole runtime implementation.
// Wire conventions: `sdk/wasm/jubjub/src/lib.rs`.

import { FIELD_BYTES, fromLeBytes, toLeBytes } from "../../core/bytes.js";
import { H_BASE, type Point } from "../jubjub.js";
import type { Field } from "../poseidon.js";
import { ensureInit, w } from "./loader.js";
import { bytesToPoint, pointToBytes } from "./point-codec.js";

export { configureJubjubWasm, type JubjubWasmLoader } from "./loader.js";

/** @internal */
export class WasmJubjub {
    private constructor(
        private readonly _base8: Point,
        private readonly _order: bigint,
    ) {}

    static async build(): Promise<WasmJubjub> {
        await ensureInit();
        const base8 = bytesToPoint(w().base8());
        const order = fromLeBytes(w().sub_order_le());
        return new WasmJubjub(base8, order);
    }

    get base8(): Point {
        return this._base8;
    }
    get order(): bigint {
        return this._order;
    }

    addPoint(a: Point, b: Point): Point {
        const out = w().add_point(pointToBytes(a), pointToBytes(b));
        return bytesToPoint(out);
    }

    mulPointEscalar(p: Point, scalar: Field): Point {
        const out = w().mul_point_escalar(
            pointToBytes(p),
            toLeBytes(scalar % this._order, FIELD_BYTES),
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

    hashToAssetGen(assetId: Field): Point {
        if (assetId >= 1n << 64n) {
            throw new Error("asset_id must be < 2^64 for HashToAssetGen parity");
        }
        const out = w().hash_to_asset_gen(toLeBytes(assetId, 8));
        return bytesToPoint(out);
    }

    valueCommit(value: Field, assetGen: Point, rcv: Field): Point {
        return this.addPoint(
            this.mulPointEscalar(assetGen, value),
            this.mulPointEscalar(H_BASE, rcv),
        );
    }

    tryDecryptNote(ivk: Field, epkPacked: Uint8Array, ciphertext: Uint8Array): Uint8Array | null {
        const out = w().try_decrypt_note(
            toLeBytes(ivk % this._order, FIELD_BYTES),
            epkPacked,
            ciphertext,
        );
        return out ? new Uint8Array(out) : null;
    }
}
