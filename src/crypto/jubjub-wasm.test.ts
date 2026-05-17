import { describe, expect, it } from "vitest";
import { WasmJubjub } from "./jubjub-wasm.js";

// Fixtures captured from circomlibjs `buildPedersenHash` against
// asset_gen.circom layout: TAG_ASSET=7 || asset_id_le(8B), then
// `babyJub.unpackPoint(...)`. Locks the in-wasm Pedersen port to the
// circuit's byte stream.
const ASSET_GEN_VECTORS: ReadonlyArray<{ assetId: bigint; x: bigint; y: bigint }> = [
    {
        assetId: 0n,
        x: 3071212243174756438411191421502495857522511533764593267968231942697527330811n,
        y: 2536909129220633182596935930597672680888667833236822480731218268580110753237n,
    },
    {
        assetId: 1n,
        x: 4167465513938357671082569831232344786850580375526847281275074108366203864553n,
        y: 7987543049353749833880690276693253205098338924142272808201612918825739328626n,
    },
    {
        assetId: 42n,
        x: 6668324546457328434056424256734493024129890096899115130578004308980249388814n,
        y: 20604746183973681697689391366607991571978028742150784403127475412308250325980n,
    },
    {
        assetId: (1n << 32n) - 1n,
        x: 4372364855759302877080153869287231101981802027261246130409563929830222467816n,
        y: 21812216257681644147515550903745703269471910816832076675896628379409392467750n,
    },
    {
        assetId: (1n << 64n) - 1n,
        x: 11777654403981500480000282784507594840913891005034115989910794122919120312594n,
        y: 97816374145297191540931260041204602948444706875130839886575397846471522524n,
    },
];

describe("WasmJubjub.hashToAssetGen", () => {
    it("matches circomlibjs Pedersen output byte-for-byte", async () => {
        const j = await WasmJubjub.build();
        for (const v of ASSET_GEN_VECTORS) {
            const [x, y] = j.hashToAssetGen(v.assetId);
            expect(x, `x mismatch for asset_id=${v.assetId}`).toBe(v.x);
            expect(y, `y mismatch for asset_id=${v.assetId}`).toBe(v.y);
        }
    });

    it("rejects asset_id >= 2^64", async () => {
        const j = await WasmJubjub.build();
        expect(() => j.hashToAssetGen(1n << 64n)).toThrow(/< 2\^64/);
    });
});
