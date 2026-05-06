// Baby-Jubjub wrapper over circomlibjs. Affine coordinates as `[x, y]` bigints.
//
// `H_BASE` is the fixed independent generator for value-commitment blinding:
//   cv = value · gen + rcv · H
// Must match `circuits/src/lib/value_commit.circom` byte-for-byte.

// @ts-expect-error — circomlibjs ships without TS types
import { buildBabyjub, buildPedersenHash } from "circomlibjs";
import { toLeBytes } from "./bytes.js";
import type { Field } from "./poseidon.js";
import { TAG_ASSET } from "./tags.js";

export type Point = [Field, Field];

export const H_BASE: Point = [
    5802099305472655231388284418920769829666717045250560929368476121199858275951n,
    5980429700218124965372158798884772646841287887664001482443826541541529227896n,
];

export class Jubjub {
    private constructor(
        private readonly babyjub: any,
        private readonly pedersen: any,
    ) {}

    static async build(): Promise<Jubjub> {
        return new Jubjub(await buildBabyjub(), await buildPedersenHash());
    }

    get base8(): Point {
        return this.toAffine(this.babyjub.Base8);
    }
    get order(): bigint {
        return this.babyjub.subOrder;
    }

    addPoint(a: Point, b: Point): Point {
        return this.toAffine(this.babyjub.addPoint(this.fromAffine(a), this.fromAffine(b)));
    }

    mulPointEscalar(p: Point, scalar: Field): Point {
        return this.toAffine(this.babyjub.mulPointEscalar(this.fromAffine(p), scalar));
    }

    inSubgroup(p: Point): boolean {
        return this.babyjub.inSubgroup(this.fromAffine(p));
    }

    // circomlibjs `packPoint` reuses an internal buffer between calls, so
    // consecutive packs alias and the older one gets clobbered. Always copy.
    packPoint(p: Point): Uint8Array {
        return new Uint8Array(this.babyjub.packPoint(this.fromAffine(p)));
    }

    unpackPoint(buf: Uint8Array): Point | null {
        const u = this.babyjub.unpackPoint(new Uint8Array(buf));
        return u ? this.toAffine(u) : null;
    }

    // Mirrors HashToAssetGen in `asset_gen.circom`: Pedersen(72) over
    //   bits[ 0.. 7] = TAG_ASSET (LSB-first byte)
    //   bits[ 8..71] = asset_id  (64 LSB-first bits)
    // circomlibjs `pedersen.hash(buf)` operates on 8·buf.length bits LSB-first
    // per byte, so the 9-byte input below reproduces the circuit bit stream
    // byte-for-byte. Circuit enforces asset_id < 2^64 via Num2Bits(64); SDK
    // matches that bound (also matches contract `uint64 publicAssetId`).
    hashToAssetGen(assetId: Field): Point {
        if (assetId >= 1n << 64n) {
            throw new Error("asset_id must be < 2^64 for HashToAssetGen parity");
        }
        const buf = new Uint8Array(9);
        buf[0] = Number(TAG_ASSET);
        buf.set(toLeBytes(assetId, 8), 1);
        const packed = this.pedersen.hash(buf);
        return this.toAffine(this.babyjub.unpackPoint(packed));
    }

    valueCommit(value: Field, assetGen: Point, rcv: Field): Point {
        const valueTerm = this.mulPointEscalar(assetGen, value);
        const blindTerm = this.mulPointEscalar(H_BASE, rcv);
        return this.addPoint(valueTerm, blindTerm);
    }

    // ---- coordinate plumbing (Montgomery FE ↔ bigint) ----
    private toCoord(fe: any): Field {
        return BigInt(this.babyjub.F.toObject(fe));
    }
    private fromCoord(x: Field): any {
        return this.babyjub.F.e(x);
    }
    private toAffine(p: any): Point {
        return [this.toCoord(p[0]), this.toCoord(p[1])];
    }
    private fromAffine(p: Point): any {
        return [this.fromCoord(p[0]), this.fromCoord(p[1])];
    }
}
