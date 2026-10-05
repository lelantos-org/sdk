// Parity: a watch wallet must see exactly what the spending wallet sees.
//
// Uses real sealed outputs and the real `LocalScanner`; a stubbed scanner ignores the key it is
// given.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { sealOutput } from "../../bundle/common.js";
import {
    buildNoteCommitment,
    buildNullifierFromNsk,
    type Field,
    Jubjub,
    Poseidon,
} from "../../crypto/index.js";
import {
    buildSpendingKey,
    fullViewingKeyFromSpending,
    type SpendingKey,
    viewingKeyFromSpending,
} from "../../keys/keys.js";
import { encodeFullViewingKey, encodeViewingKey } from "../../keys/viewing-key.js";
import { deriveOutgoingKey } from "../../notes/outgoing.js";
import type { NotePage, NoteSource } from "../../sync/note-source.js";
import type { NullifierStore } from "../../sync/nullifier-store.js";
import type { ScanInput } from "../../sync/scan.js";
import { recipientAt, sealedScanInput } from "../../test-utils/outputs.js";
import { testWallet } from "../../test-utils/wallet.js";
import type { ReadOnlyWalletApi } from "../api.js";
import { InMemoryNoteStore } from "../notes/note-store.js";
import type { WalletNote } from "../types/results.js";
import { connectWatch } from "./connect.js";
import { createWatchWallet } from "./watch-wallet.js";

const NSK = 4242n;
/** The account paying every note in the feed. */
const SENDER_NSK = 777n;
const CHAIN_ID = 31337n;
const LAST_INDEX = 2 ** 32 - 1;

/** One note per payment, each to the address of `NSK` at `index`. The first is spent on chain. */
const PAYMENTS = [
    { index: 5, asset: 1n, value: 500n, rho: 111n },
    { index: 0, asset: 1n, value: 250n, rho: 444n },
    { index: LAST_INDEX, asset: 2n, value: 700n, rho: 777n },
];

describe("watch wallet parity", () => {
    let P: Poseidon;
    let J: Jubjub;
    let sk: SpendingKey;
    /** The account's viewing key at each tier, encoded. */
    let fullKey: string;
    let incomingKey: string;
    /** The notes the feed serves, and the nullifier of the one that is spent. */
    let feed: ScanInput[];
    /** The diversifier each payment was addressed to, in feed order. */
    let paidTo: Field[];
    let spentNf: Field;

    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
        sk = buildSpendingKey(P, NSK);
        fullKey = encodeFullViewingKey(fullViewingKeyFromSpending(sk));
        incomingKey = encodeViewingKey(viewingKeyFromSpending(sk));

        const outgoingKey = deriveOutgoingKey(SENDER_NSK);
        const sealed = PAYMENTS.map(({ index, ...note }) => {
            const recipient = recipientAt(P, J, sk, index);
            const output = { outgoingKey, chainId: CHAIN_ID, ...note, recipient, nullifiers: [] };
            return { recipient, ...sealOutput(J, P, output) };
        });
        feed = sealed.map((output, i) =>
            sealedScanInput(P, J, output, { leafIndex: i, blockNumber: 9 + i }),
        );
        paidTo = sealed.map(({ recipient }) => recipient.d);
        const first = sealed[0]!.note;
        spentNf = buildNullifierFromNsk(P, NSK, first.rho, buildNoteCommitment(P, first));
    });

    /** Serves the whole feed once, then nothing, as a caught-up server does. */
    function noteSource(): NoteSource {
        return {
            listNotes: async (opts = {}): Promise<NotePage> => {
                const after = opts.after ?? 0;
                if (after > 0) return { inputs: [], nextAfter: after, resumeAfter: after };
                return { inputs: feed, nextAfter: feed.length, resumeAfter: feed.length };
            },
        };
    }

    /** The watch side's mirror; the spending side gets one from `testWallet`. */
    function nullifierStore(): NullifierStore {
        return {
            sync: vi.fn(async () => undefined),
            has: (nf: bigint) => nf === spentNf,
        } as unknown as NullifierStore;
    }

    async function spendingWallet() {
        const { wallet } = await testWallet({
            nsk: NSK,
            noteSource: noteSource(),
            spent: new Set([spentNf]),
        });
        return wallet;
    }

    async function watchWallet(key: string): Promise<ReadOnlyWalletApi> {
        return createWatchWallet(key, {
            chainId: CHAIN_ID,
            fmdUrl: "http://fmd.invalid",
            noteStore: new InMemoryNoteStore(),
            noteSource: noteSource(),
            nullifierStore: nullifierStore(),
        });
    }

    // Keyed on `cm`, not `id`: ids are minted per store, so two wallets scanning the same feed
    // agree on every note and on none of the ids.
    const shape = async (w: { notes: () => Promise<WalletNote[]> }) =>
        (await w.notes())
            .map((n) => ({
                cm: n.cm,
                asset: n.asset,
                value: n.value,
                spent: n.spent,
                d: n.notePayload().d,
            }))
            .sort((a, b) => a.cm.localeCompare(b.cm));
    const balance = (w: ReadOnlyWalletApi, asset: bigint) =>
        w.state().balances.get(asset as never) ?? 0n;

    it("an FVK watch wallet matches the spending wallet exactly", async () => {
        const spend = await spendingWallet();
        const watch = await watchWallet(fullKey);

        await spend.sync({ scope: "notes" });
        const report = await watch.sync();

        expect(watch.address).toBe(spend.address);
        expect(watch.spentKnown).toBe(true);
        expect(watch.keys).toMatchObject({
            tier: "full",
            viewingKey: spend.keys.viewingKey,
            fullViewingKey: spend.keys.fullViewingKey,
        });
        const seen = await shape(watch);
        expect(seen).toEqual(await shape(spend));
        // Every address of the account receives, not only the one at index 0.
        expect(seen.map((n) => n.d).sort()).toEqual([...paidTo].sort());
        expect(balance(watch, 1n)).toBe(balance(spend, 1n));
        expect(balance(watch, 2n)).toBe(balance(spend, 2n));
        // The spent note is marked spent, not dropped.
        expect(await watch.notes({ spent: true })).toHaveLength(1);
        // A watch wallet keeps no tree, and a full key mirrors the spent set.
        expect(report.tree).toBeUndefined();
    });

    it("an IVK watch wallet sees the same notes but cannot settle spends", async () => {
        const spend = await spendingWallet();
        const watch = await watchWallet(incomingKey);

        await spend.sync({ scope: "notes" });
        const report = await watch.sync({ scope: "full" });

        expect(watch.address).toBe(spend.address);
        expect(watch.spentKnown).toBe(false);
        expect(watch.keys).toMatchObject({
            tier: "incoming",
            viewingKey: spend.keys.viewingKey,
            fullViewingKey: undefined,
        });
        expect(await watch.notes()).toHaveLength(PAYMENTS.length);
        expect(await spend.notes()).toHaveLength(PAYMENTS.length);
        expect(await watch.notes({ spent: true })).toHaveLength(0);
        // Its balance is therefore everything received, the spent note included.
        expect(balance(watch, 1n)).toBe(balance(spend, 1n) + 500n);
        // An incoming key cannot use the spent set, so it is not fetched; "full" is "notes" here.
        expect(report.nullifiers).toBeUndefined();
        expect(report.tree).toBeUndefined();
    });

    it("derives the spending wallet's address at every index, from either key tier", async () => {
        const spend = await spendingWallet();
        const full = await watchWallet(fullKey);
        const incoming = await watchWallet(incomingKey);

        const addresses = new Set<string>();
        for (const index of [0, 1, 5, LAST_INDEX]) {
            const address = await spend.addressAt(index);
            expect(await full.addressAt(index)).toBe(address);
            expect(await incoming.addressAt(index)).toBe(address);
            addresses.add(address);
        }
        expect(addresses.size).toBe(4);
        expect(await full.addressAt(0)).toBe(full.address);
        expect(await incoming.addressAt(0)).toBe(spend.address);

        for (const index of [-1, 1.5, LAST_INDEX + 1]) {
            await expect(incoming.addressAt(index)).rejects.toMatchObject({
                code: "INVALID_ARGUMENT",
                context: { op: "addressAt" },
            });
        }
    });

    it("connectWatch builds a reader from the preset's rpcUrl without contacting it", async () => {
        const watch = await connectWatch({
            network: "anvil",
            viewingKey: fullKey,
            storage: { notes: new InMemoryNoteStore() },
        });
        expect(watch.keys.tier).toBe("full");
        expect(Object.isFrozen(watch)).toBe(true);
        await watch.dispose();
    });
});
