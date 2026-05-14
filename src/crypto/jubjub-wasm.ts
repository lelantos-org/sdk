// WASM-backed Baby-Jubjub. Structurally compatible with circomlibjs `Jubjub`.
// `hashToAssetGen` delegates to circomlibjs (lazy-loaded) — circuits lock the
// Pedersen-264 bit-stream byte-for-byte to that impl.
// Wire conventions: `sdk/wasm/jubjub/src/lib.rs`.

import { createWasmLoader, type WasmLoaderOverride, type WasmModuleBase } from "../wasm/loader.js";
import { FIELD_BYTES, fromLeBytes, toLeBytes } from "./bytes.js";
// Type-only — runtime load of `jubjub.js` (and its `circomlibjs` dep) is
// deferred to `getFallback()` so this module stays worker-importable.
import type { Jubjub as CircomlibJubjub, Jubjub, Point } from "./jubjub.js";
import type { Field, Poseidon } from "./poseidon.js";

// Inlined to keep this module's runtime imports `circomlibjs`-free.
// Mirrors `H_BASE` in `./jubjub.ts`.
const H_BASE: Point = [
    5802099305472655231388284418920769829666717045250560929368476121199858275951n,
    5980429700218124965372158798884772646841287887664001482443826541541529227896n,
];

/// Mirrors `TAG_FMD_BIT` in `sdk/src/fmd.ts` + `circuits/src/lib/tags.circom`.
const TAG_FMD_BIT: bigint = 8n;

interface JubWasmMod extends WasmModuleBase {
    add_point(a: Uint8Array, b: Uint8Array): Uint8Array;
    base8(): Uint8Array;
    in_subgroup(p: Uint8Array): boolean;
    mul_point_escalar(p: Uint8Array, scalar_le: Uint8Array): Uint8Array;
    pack_point(p: Uint8Array): Uint8Array;
    sub_order_le(): Uint8Array;
    try_decrypt_note(
        ivk_le: Uint8Array,
        epk_packed: Uint8Array,
        ciphertext: Uint8Array,
    ): Uint8Array | undefined;
    unpack_point(buf: Uint8Array): Uint8Array | undefined;
}

const POINT_BYTES = 64;

/// Override for bundlers that rewrite `new URL(..., import.meta.url)` to a
/// runtime-invalid location. Call before `WasmJubjub.build()`.
export type JubjubWasmLoader = WasmLoaderOverride<JubWasmMod>;

const PKG_JS_URL = new URL("../../wasm/jubjub/pkg/jubjub_wasm.js", import.meta.url);
const PKG_WASM_URL = new URL("../../wasm/jubjub/pkg/jubjub_wasm_bg.wasm", import.meta.url);

// Specifiers held in variables (+ `@vite-ignore` below) so Vite skips static
// resolution. `node:url` is Node-only; `#wasm/jubjub` requires either a Node
// runtime or an injected loader.
const NODE_URL = "node:url";
const WASM_JUBJUB_SUBPATH = "#wasm/jubjub";

const loader = createWasmLoader<JubWasmMod>({
    name: "jubjub",
    defaultImport: () => import(/* @vite-ignore */ WASM_JUBJUB_SUBPATH) as Promise<JubWasmMod>,
    nodeJsUrl: async () => PKG_JS_URL.href,
    nodeWasmPath: async () => {
        const { fileURLToPath } = await import(/* @vite-ignore */ NODE_URL);
        return fileURLToPath(PKG_WASM_URL);
    },
});

/// Call once at app boot, before `WasmJubjub.build()`.
export function configureJubjubWasm(override: JubjubWasmLoader): void {
    loader.configure(override);
}

let jubWasm: JubWasmMod | null = null;

async function ensureInit(): Promise<void> {
    jubWasm = await loader.load();
}

function w(): JubWasmMod {
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
    return [fromLeBytes(b.slice(0, FIELD_BYTES)), fromLeBytes(b.slice(FIELD_BYTES, POINT_BYTES))];
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
        // Fallback (`circomlibjs.Jubjub`) is loaded lazily on first
        // `hashToAssetGen` call — eager load would drag `circomlibjs` /
        // CJS `blake2b` into every importer, breaking Vite workers.
        return new WasmJubjub(base8, order);
    }

    private async getFallback(): Promise<CircomlibJubjub> {
        if (this.fallback) return this.fallback;
        const { Jubjub } = await import("./jubjub.js");
        this.fallback = await Jubjub.build();
        return this.fallback;
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
        if (!this.fallback) {
            throw new Error(
                "hashToAssetGen: circomlibjs fallback not initialized; call hashToAssetGenAsync first",
            );
        }
        return this.fallback.hashToAssetGen(assetId);
    }

    async hashToAssetGenAsync(assetId: Field): Promise<Point> {
        if (assetId >= 1n << 64n) {
            throw new Error("asset_id must be < 2^64 for HashToAssetGen parity");
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

    // FMD2 (Niwl) v2 detection. Mirrors `fmdTest` in `sdk/src/fmd.ts` and in-circuit `ClueCheck`.
    // Hash stays in JS so the wasm artifact does not need a Poseidon dependency.
    fmdTest(
        P: Poseidon,
        dk: Field[],
        cluePackedR: Uint8Array,
        clueBits: Uint8Array,
        gamma: number,
    ): boolean {
        if (dk.length !== gamma) return false;
        if (clueBits.length !== Math.ceil(gamma / 8)) return false;
        const R = this.unpackPoint(cluePackedR);
        if (!R || !this.inSubgroup(R)) return false;

        for (let i = 0; i < gamma; i++) {
            const shared = this.mulPointEscalar(R, dk[i]);
            const h = P.hash([TAG_FMD_BIT, R[0], R[1], BigInt(i), shared[0], shared[1]]);
            const bit = Number(h & 1n);
            const cBit = (clueBits[i >> 3] >> (i & 7)) & 1;
            if ((bit ^ cBit) !== 1) return false;
        }
        return true;
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

/// Build the WASM-backed jubjub typed as the nominal `Jubjub` class. Parity is locked by
/// `jubjub-wasm.test.ts`; TS can't see structural compatibility across nominal class types.
export async function buildJubjub(): Promise<Jubjub> {
    return (await WasmJubjub.build()) as unknown as Jubjub;
}
