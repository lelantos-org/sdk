// WASM-backed Baby-Jubjub. Same shape as the circomlibjs `Jubjub` class so it
// drops into `Wallet`, `LocalScanner`, `WorkerPoolScanner`, etc. with no
// caller changes.
//
// `hashToAssetGen` is delegated to circomlibjs (lazy-loaded) because it depends
// on a specific Pedersen-264 bit-stream that the circuit locks to circomlibjs
// byte-for-byte. Lazy load lets browser bundles that don't touch asset_gen
// omit the Node-flavored circomlibjs dep entirely.
//
// Wire conventions are described in `sdk/wasm/jubjub/src/lib.rs`.

import { H_BASE, type Point } from "./jubjub";
import type { Jubjub as CircomlibJubjub } from "./jubjub";
import { toLeBytes, fromLeBytes, FIELD_BYTES } from "./bytes";
import type { Field } from "./poseidon";

// wasm-pack output. CI builds this; consumers receive it via npm dist.
// Type-only — actual module loaded lazily via real dynamic import (TS lowers
// `import(...)` to `require()` under `module: commonjs`, which fails for the
// ESM-shaped wasm-pack output with ERR_REQUIRE_ESM).
// @ts-ignore — generated module
import type * as JubWasmMod from "../../wasm/jubjub/pkg/jubjub_wasm.js";

const POINT_BYTES = 64;

// Indirect eval: bypasses TS CJS lowering so `import()` stays a real ESM import.
const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;

let jubWasm: typeof JubWasmMod | null = null;

let inited: Promise<void> | null = null;
function ensureInit(): Promise<void> {
    if (!inited) inited = doInit().then(() => undefined);
    return inited;
}

async function doInit(): Promise<void> {
    if (typeof process !== "undefined" && process.versions?.node) {
        const { readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const { pathToFileURL } = await import("node:url");
        const pkgDir = join(__dirname, "..", "..", "wasm", "jubjub", "pkg");
        const mod = (await esmImport(pathToFileURL(join(pkgDir, "jubjub_wasm.js")).href)) as typeof JubWasmMod;
        const bytes = await readFile(join(pkgDir, "jubjub_wasm_bg.wasm"));
        await mod.default({ module_or_path: bytes });
        jubWasm = mod;
        return;
    }
    const mod = (await esmImport("../../wasm/jubjub/pkg/jubjub_wasm.js")) as typeof JubWasmMod;
    await mod.default();
    jubWasm = mod;
}

function w(): typeof JubWasmMod {
    if (!jubWasm) throw new Error("WasmJubjub not initialized; call WasmJubjub.build() first");
    return jubWasm;
}

function pointToBytes(p: Point): Uint8Array {
    const out = new Uint8Array(POINT_BYTES);
    out.set(toLeBytes(p[0], FIELD_BYTES), 0);
    out.set(toLeBytes(p[1], FIELD_BYTES), FIELD_BYTES);
    return out;
}

function bytesToPoint(b: Uint8Array): Point {
    return [
        fromLeBytes(b.slice(0, FIELD_BYTES)),
        fromLeBytes(b.slice(FIELD_BYTES, POINT_BYTES)),
    ];
}

export class WasmJubjub {
    private fallback: CircomlibJubjub | null = null;

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

    private async getFallback(): Promise<CircomlibJubjub> {
        if (this.fallback) return this.fallback;
        const { Jubjub } = await import("./jubjub");
        this.fallback = await Jubjub.build();
        return this.fallback;
    }

    get base8(): Point { return this._base8; }
    get order(): bigint { return this._order; }

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
        if (assetId >= 1n << 254n) {
            throw new Error("asset_id must be < 2^254 for HashToAssetGen parity");
        }
        if (!this.fallback) {
            throw new Error(
                "hashToAssetGen: circomlibjs fallback not initialized; call hashToAssetGenAsync first",
            );
        }
        return this.fallback.hashToAssetGen(assetId);
    }

    async hashToAssetGenAsync(assetId: Field): Promise<Point> {
        if (assetId >= 1n << 254n) {
            throw new Error("asset_id must be < 2^254 for HashToAssetGen parity");
        }
        const fb = await this.getFallback();
        return fb.hashToAssetGen(assetId);
    }

    valueCommit(value: Field, assetGen: Point, rcv: Field): Point {
        return this.addPoint(
            this.mulPointEscalar(assetGen, value),
            this.mulPointEscalar(H_BASE, rcv),
        );
    }

    fmdTest(dkLe: Uint8Array, clueR: Uint8Array, clueBits: Uint8Array, gamma: number): boolean {
        return w().fmd_test(dkLe, clueR, clueBits, gamma);
    }

    tryDecryptNote(
        ivk: Field,
        epkPacked: Uint8Array,
        ciphertext: Uint8Array,
    ): Uint8Array | null {
        const out = w().try_decrypt_note(
            toLeBytes(ivk % this._order, FIELD_BYTES),
            epkPacked,
            ciphertext,
        );
        return out ? new Uint8Array(out) : null;
    }
}
