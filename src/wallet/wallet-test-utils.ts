// Shared fixtures for the wallet test suites.
//
// Three suites need a real `Wallet` with every network-touching pluggable
// stubbed, and each had grown its own near-identical copy — so a change to
// `WalletConfig` meant editing the same fixture three times, and the three
// had already drifted apart in what they stubbed.
//
// Not shipped: excluded from coverage by the `*test-utils*` pattern in
// `vitest.config.ts`, and imported only from `*.test.ts`.

import { type Mock, vi } from "vitest";
import type { ChainAdapter } from "../chain/port.js";
import { hex32 } from "../core/brand.js";
import { randomFr, randomJubjubScalar } from "../core/random.js";
import type { RelayerSubmitResponse } from "../protocol/responses.js";
import type { Prover } from "../prover/types.js";
import type { ScanHit, ScanInput } from "../sync/scan.js";
import type { Scanner } from "../sync/scanner.js";
import type { WalletConfig } from "./config.js";
import type { ListNotesOpts, NotePage, NoteSource } from "./note-source.js";
import { InMemoryNoteStore, type NoteStore, type StoredNote } from "./note-store.js";
import type { NullifierStore } from "./nullifier-store.js";
import type { RootCheck } from "./tree-store.js";
import { Wallet } from "./wallet.js";

/** The spendability knobs the selector reads. All optional. */
export interface StoredNoteOpts {
    asset?: bigint;
    spent?: boolean;
    /** Drives the selector's spend cooldown, against a `tipBlock`. */
    firstSeenBlock?: number;
    /** ISO stamp; withholds the note while an earlier spend may still land. */
    pendingSpendAt?: string;
}

/**
 * A stored note with deterministic id and fresh randomness.
 *
 * The opts bag exists because the selection suites need to drive the
 * spendability rules, and each had grown its own copy of this to do it — the
 * same drift this module was created to stop.
 */
export function storedNote(id: string, value = 100n, opts: StoredNoteOpts = {}): StoredNote {
    return {
        id,
        asset: (opts.asset ?? 1n).toString(),
        value: value.toString(),
        rho: randomFr().toString(),
        rcm: randomFr().toString(),
        rcvDep: randomJubjubScalar().toString(),
        cm: `0x${id.padStart(64, "0")}`,
        leafIndex: Number.parseInt(id, 16) || 0,
        spent: opts.spent ?? false,
        discoveredAt: "1970-01-01T00:00:00Z",
        ...(opts.firstSeenBlock !== undefined ? { firstSeenBlock: opts.firstSeenBlock } : {}),
        ...(opts.pendingSpendAt !== undefined ? { pendingSpendAt: opts.pendingSpendAt } : {}),
    };
}

/** A scan hit that is not any stored note. */
export function incomingHit(over: Partial<ScanHit> = {}): ScanHit {
    return {
        asset: 1n,
        value: 500n,
        rho: randomFr(),
        rcm: randomFr(),
        rcvDep: randomJubjubScalar(),
        cm: BigInt(`0x${"be".repeat(16)}`),
        leafIndex: 7,
        blockNumber: 42,
        ...over,
    };
}

/** Scanner that reports `hits` on its first call and nothing afterwards. */
export function scannerYielding(hits: ScanHit[]): Scanner {
    let served = false;
    return {
        async scan() {
            if (served) return [];
            served = true;
            return hits;
        },
    };
}

const feedRow = (id: number): ScanInput => ({
    ciphertext: new Uint8Array(0),
    epk: new Uint8Array(32),
    cm: BigInt(id),
    leafIndex: id,
    blockNumber: 42,
});

/**
 * Append-only note feed of `total` rows, paging on `after` as the server does.
 *
 * Yields a tick per page so two concurrent syncs genuinely interleave rather
 * than each running to completion in one microtask burst — which is what makes
 * the serialisation tests meaningful.
 */
export function fakeNoteSource(total: number): FakeNoteSource {
    const listNotes = vi.fn(async (opts: ListNotesOpts = {}): Promise<NotePage> => {
        await new Promise((r) => setTimeout(r, 0));
        const after = opts.after ?? 0;
        const limit = opts.limit ?? 1000;
        const ids: number[] = [];
        for (let id = after + 1; id <= total && ids.length < limit; id++) ids.push(id);
        const hi = ids.at(-1) ?? after;
        return { inputs: ids.map(feedRow), nextAfter: hi, resumeAfter: hi };
    });
    return { listNotes };
}

/** A `NoteSource` whose `listNotes` is a spy, so call counts are assertable. */
export interface FakeNoteSource extends NoteSource {
    listNotes: Mock<(opts?: ListNotesOpts) => Promise<NotePage>>;
}

export interface TestWalletOpts {
    /** Notes already in the store. */
    notes?: StoredNote[];
    /** Nullifiers the mirror reports as spent on chain. */
    spent?: Set<bigint>;
    scanner?: Scanner;
    prover?: Prover;
    /** Rows the note feed serves. Default 1. */
    feedRows?: number;
    noteStore?: NoteStore;
}

/**
 * A `Wallet` with every network-touching pluggable stubbed.
 *
 * Returns the stubs alongside it, so a suite can drive the chain state a test
 * is actually about (`spent.add(nf)`, `source.listNotes` call counts) without
 * reaching into the wallet's internals.
 */
export async function testWallet(opts: TestWalletOpts = {}) {
    const noteStore = opts.noteStore ?? new InMemoryNoteStore();
    await noteStore.save({ version: 2, notes: opts.notes ?? [] });

    const spent = opts.spent ?? new Set<bigint>();
    const nullifierStore = {
        sync: vi.fn(async () => undefined),
        has: (nf: bigint) => spent.has(nf),
    } as unknown as NullifierStore;

    const source = fakeNoteSource(opts.feedRows ?? 1);

    // Typed as `WalletConfig` rather than cast away wholesale, so a change to
    // the config shape still fails here. `chain` and `submitter` are the two
    // pluggables no suite using this fixture exercises — every one of them
    // drives the local store and the note feed instead.
    const config: WalletConfig = {
        chainId: 31337n,
        treeDepth: 10,
        relayerAddress: `0x${"11".repeat(20)}`,
        chain: {} as ChainAdapter,
        fmdUrl: "http://fmd.invalid",
        noteStore,
        noteSource: source,
        nullifierStore,
        submitter: {
            submit: async (): Promise<RelayerSubmitResponse> => ({
                txHash: hex32(`0x${"ab".repeat(32)}`),
            }),
        },
        ...(opts.scanner ? { scanner: opts.scanner } : {}),
        ...(opts.prover ? { prover: opts.prover } : {}),
    };

    const wallet = await Wallet.create({ type: "nsk", nsk: randomJubjubScalar() }, config);

    return { wallet, noteStore, nullifierStore, source, spent };
}

/**
 * A `RootCheck` whose roots agree — a tree the chain would accept a proof
 * against.
 *
 * The roots, not a flag, decide that: `RootCheck` carries no verdict field
 * precisely so a fixture cannot claim agreement while spelling two different
 * roots.
 */
export function reconciled(leaves = 4): RootCheck {
    return { localRoot: 0n, chainRoot: 0n, localLeaves: leaves, chainLeaves: leaves };
}

/** A `RootCheck` whose roots differ, for the paths that must refuse to prove. */
export function unreconciled(localLeaves = 4, chainLeaves = 4): RootCheck {
    return { localRoot: 0n, chainRoot: 1n, localLeaves, chainLeaves };
}

/**
 * The `TreeStore` surface a spend touches: reconcile, then read paths from a
 * depth-4 tree.
 *
 * Shared because both spend suites build the same one, and `RootCheck` gaining
 * a field would otherwise mean editing two fixtures — the drift this module
 * exists to stop.
 */
export function stubTreeStore(depth = 4) {
    return {
        syncVerified: vi.fn(async () => reconciled()),
        root: () => 0n,
        getPath: () => ({
            pathElements: Array.from({ length: depth }, () => [0n, 0n, 0n]),
            pathIndices: Array.from({ length: depth }, () => 0),
            root: 0n,
        }),
    };
}
