import { describe, expect, it } from "vitest";
import type { EvmAddress, Hex32 } from "../core/brand.js";
import { keccak256 } from "../crypto/keccak.js";
import {
    locateOperation,
    NOTE_PAYLOAD_TOPIC,
    NULLIFIER_CONSUMED_TOPIC,
    ROOT_ADVANCED_TOPIC,
} from "./operation.js";
import type { TxLog } from "./types.js";

// Synthetic receipts laid out as the pool emits them per bundle item — see the
// layout pinned by `Bundler.t.sol::test_execute_mixedBundle_logLayout`.

const POOL = "0x2887cDe0763178e199A99289dbA9b46DB4d9DB2e" as EvmAddress;
const TOKEN = "0x00000000000000000000000000000000000000aa" as EvmAddress;

const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex32;
const topic = (sig: string) => keccak256(new TextEncoder().encode(sig));
const ASSET_MOVED = topic("AssetMoved(uint64,address,uint256,uint256,uint64,uint64)");
const DEPOSIT_FLUSHED = topic("DepositFlushed(uint256,bytes32)");
const DEPOSIT_ESCROWED = topic(
    "DepositEscrowed(uint256,address,address,uint64,uint64,uint16,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes,uint64,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes)",
);
const TRANSFER = topic("Transfer(address,address,uint256)");

const log = (t0: Hex32, t1?: Hex32, address: EvmAddress = POOL): TxLog => ({
    address,
    topics: t1 === undefined ? [t0] : [t0, t1],
});
const nullifiers = (seed: number) =>
    Array.from({ length: 4 }, (_, i) => log(NULLIFIER_CONSUMED_TOPIC, word(seed + i)));
const root = () => log(ROOT_ADVANCED_TOPIC, word(0));
const payloads = (cms: Hex32[]) => cms.map((cm) => log(NOTE_PAYLOAD_TOPIC, cm));
const outputs = (seed: number) => Array.from({ length: 6 }, (_, i) => word(seed + i));

const flush = (n: number) => [
    ...Array.from({ length: n }, (_, i) => log(DEPOSIT_FLUSHED, word(0xf00 + i))),
    root(),
];
const transfer = (cms: Hex32[]) => [...nullifiers(0x100), root(), ...payloads(cms)];
const withdraw = (cms: Hex32[]) => [
    ...nullifiers(0x200),
    root(),
    log(ASSET_MOVED, word(1)),
    // The token's own Transfer, from another contract, lands before AssetMoved
    // in practice; interleaved here to prove foreign logs are skipped.
    log(TRANSFER, word(2), TOKEN),
    ...payloads(cms),
];
const swap = (cms: Hex32[]) => [
    ...withdraw(cms),
    log(DEPOSIT_ESCROWED, word(9)),
    log(ASSET_MOVED, word(1)),
];

describe("event topics", () => {
    it("match the pool's event signatures", () => {
        expect(NOTE_PAYLOAD_TOPIC).toBe(
            topic("NotePayload(bytes32,uint256,uint256,uint256,uint256,bytes,uint256,uint256)"),
        );
        expect(ROOT_ADVANCED_TOPIC).toBe(topic("RootAdvanced(uint64,uint64,bytes32,bytes32)"));
        expect(NULLIFIER_CONSUMED_TOPIC).toBe(topic("NullifierConsumed(bytes32)"));
    });
});

describe("locateOperation", () => {
    it("finds a lone operation as 1 of 1", () => {
        const mine = outputs(0xa0);
        const logs = transfer(mine);
        expect(locateOperation(logs, POOL, mine)).toEqual({
            index: 0,
            count: 1,
            logRange: [0, 10],
        });
    });

    it("finds each operation of a [flush, transfer, withdraw] bundle", () => {
        const t = outputs(0xa0);
        const w = outputs(0xb0);
        const logs = [...flush(2), ...transfer(t), ...withdraw(w)];

        // flush: 0-2, transfer: 3-13, withdraw: 14-26.
        expect(locateOperation(logs, POOL, t)).toEqual({
            index: 1,
            count: 3,
            logRange: [3, 13],
        });
        expect(locateOperation(logs, POOL, w)).toEqual({
            index: 2,
            count: 3,
            logRange: [14, 26],
        });
    });

    it("ignores trailing swap logs and later operations", () => {
        const s = outputs(0xc0);
        const t = outputs(0xd0);
        const logs = [...swap(s), ...transfer(t)];
        expect(locateOperation(logs, POOL, s)).toEqual({
            index: 0,
            count: 2,
            logRange: [0, 12],
        });
        expect(locateOperation(logs, POOL, t)?.index).toBe(1);
    });

    it("matches on any one commitment, in any case", () => {
        const mine = outputs(0xa0);
        const logs = [...flush(1), ...transfer(mine)];
        const upper = (mine[3] as string).toUpperCase().replace("0X", "0x");
        expect(locateOperation(logs, POOL.toLowerCase(), [upper])).toEqual({
            index: 1,
            count: 2,
            // Only the matched payload bounds the range: slot 3 of 6.
            logRange: [2, 10],
        });
    });

    it("does not match payloads emitted by another contract", () => {
        const mine = outputs(0xa0);
        const spoofed = [
            ...nullifiers(0),
            root(),
            ...mine.map((cm) => log(NOTE_PAYLOAD_TOPIC, cm, TOKEN)),
        ];
        expect(locateOperation(spoofed, POOL, mine)).toBeUndefined();
    });

    it("is undefined when the commitments are absent or empty", () => {
        const logs = transfer(outputs(0xa0));
        expect(locateOperation(logs, POOL, outputs(0xe0))).toBeUndefined();
        expect(locateOperation(logs, POOL, [])).toBeUndefined();
        expect(locateOperation([], POOL, outputs(0xa0))).toBeUndefined();
    });

    it("is undefined when no root precedes the payloads", () => {
        const mine = outputs(0xa0);
        expect(locateOperation([...payloads(mine), root()], POOL, mine)).toBeUndefined();
    });
});
