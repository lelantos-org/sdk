// Parity: a watch wallet must see exactly what the spending wallet sees.
//
// Uses real encrypted notes and the real `LocalScanner`; a stubbed scanner
// ignores the key it is given.

import { beforeAll, describe, expect, it, vi } from "vitest";
import {
    BABYJUB_SUBGROUP_ORDER,
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
import { clueBitsToPrefix, encodeNotePayload, type NotePayload } from "../../notes/codec.js";
import { encryptNote } from "../../notes/encrypt.js";
import type { NotePage, NoteSource } from "../../sync/note-source.js";
import type { NullifierStore } from "../../sync/nullifier-store.js";
import type { ScanInput } from "../../sync/scan.js";
import { testWallet } from "../../test-utils/wallet.js";
import type { ReadOnlyWalletApi } from "../api.js";
import { InMemoryNoteStore } from "../notes/note-store.js";
import type { WalletNote } from "../types/results.js";
import { connectWatch } from "./connect.js";
import { createWatchWallet } from "./watch-wallet.js";

const NSK = 4242n;

describe("watch wallet parity", () => {
    let P: Poseidon;
    let J: Jubjub;
    let sk: SpendingKey;
    /** The notes the feed serves, and the nullifier of the one that is spent. */
    let feed: ScanInput[];
    let spentNf: Field;

    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
        sk = buildSpendingKey(P, J, NSK);

        const notes: NotePayload[] = [
            { asset: 1n, value: 500n, rho: 111n, rcm: 222n, rcvDep: 333n },
            { asset: 1n, value: 250n, rho: 444n, rcm: 555n, rcvDep: 666n },
            { asset: 2n, value: 700n, rho: 777n, rcm: 888n, rcvDep: 999n },
        ];
        feed = notes.map((n, i) => input(n, i));
        // The first note has been spent on chain.
        const first = notes[0] as NotePayload;
        spentNf = buildNullifierFromNsk(
            P,
            NSK,
            first.rho,
            buildNoteCommitment(P, { ...first, pk: sk.pk }),
        );
    });

    function input(note: NotePayload, i: number): ScanInput {
        const enc = encryptNote({
            J,
            recipientPkD: sk.pk_d,
            esk: (777n + BigInt(i)) % BABYJUB_SUBGROUP_ORDER,
            plaintext: encodeNotePayload(note),
        });
        return {
            ciphertext: new Uint8Array([
                ...clueBitsToPrefix(new Uint8Array([0]), 5),
                ...enc.ciphertext,
            ]),
            epk: enc.epk,
            cm: buildNoteCommitment(P, { ...note, pk: sk.pk }),
            leafIndex: i,
            blockNumber: 9 + i,
        };
    }

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
            chainId: 31337n,
            fmdUrl: "http://fmd.invalid",
            noteStore: new InMemoryNoteStore(),
            noteSource: noteSource(),
            nullifierStore: nullifierStore(),
        });
    }

    // Keyed on `cm`, not `id`: ids are minted per store, so two wallets scanning
    // the same feed agree on every note and on none of the ids.
    const shape = async (w: { notes: () => Promise<WalletNote[]> }) =>
        (await w.notes())
            .map((n) => ({ cm: n.cm, asset: n.asset, value: n.value, spent: n.spent }))
            .sort((a, b) => a.cm.localeCompare(b.cm));
    const balance = (w: ReadOnlyWalletApi, asset: bigint) =>
        w.state().balances.get(asset as never) ?? 0n;

    it("an FVK watch wallet matches the spending wallet exactly", async () => {
        const spend = await spendingWallet();
        const watch = await watchWallet(encodeFullViewingKey(fullViewingKeyFromSpending(sk)));

        await spend.sync({ scope: "notes" });
        const report = await watch.sync();

        expect(watch.address).toBe(spend.address);
        expect(watch.spentKnown).toBe(true);
        expect(watch.keys).toMatchObject({
            tier: "full",
            viewingKey: spend.keys.viewingKey,
            fullViewingKey: spend.keys.fullViewingKey,
        });
        expect(await shape(watch)).toEqual(await shape(spend));
        expect(balance(watch, 1n)).toBe(balance(spend, 1n));
        expect(balance(watch, 2n)).toBe(balance(spend, 2n));
        // The spent note is actually settled, not merely absent.
        expect(await watch.notes({ spent: true })).toHaveLength(1);
        // A watch wallet keeps no tree, and a full key mirrors the spent set.
        expect(report.tree).toBeUndefined();
    });

    it("an IVK watch wallet sees the same notes but cannot settle spends", async () => {
        const spend = await spendingWallet();
        const watch = await watchWallet(encodeViewingKey(viewingKeyFromSpending(sk)));

        await spend.sync({ scope: "notes" });
        const report = await watch.sync({ scope: "full" });

        expect(watch.address).toBe(spend.address);
        expect(watch.spentKnown).toBe(false);
        expect(watch.keys).toMatchObject({
            tier: "incoming",
            viewingKey: spend.keys.viewingKey,
            fullViewingKey: undefined,
        });
        expect(await watch.notes()).toHaveLength((await spend.notes()).length);
        expect(await watch.notes({ spent: true })).toHaveLength(0);
        // Its balance is therefore everything received, the spent note included.
        expect(balance(watch, 1n)).toBe(balance(spend, 1n) + 500n);
        // An incoming key cannot use the spent set, so it is not fetched; "full" is "notes" here.
        expect(report.nullifiers).toBeUndefined();
        expect(report.tree).toBeUndefined();
    });

    it("connectWatch builds a reader from the preset's rpcUrl without contacting it", async () => {
        const watch = await connectWatch({
            network: "anvil",
            viewingKey: encodeFullViewingKey(fullViewingKeyFromSpending(sk)),
            storage: { notes: new InMemoryNoteStore() },
        });
        expect(watch.keys.tier).toBe("full");
        expect(Object.isFrozen(watch)).toBe(true);
        await watch.dispose();
    });
});
