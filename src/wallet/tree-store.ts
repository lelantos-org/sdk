// Local Merkle tree store: syncs commitment chunks from the server and computes
// Merkle paths without revealing which note is being spent.
//
// Leaves arrive pre-hashed: the server sends `Poseidon(TAG_LEAF, cm, cv_dep_x,
// cv_dep_y)` per entry, so this file no longer hashes anything at the leaf
// level and `Poseidon` is used only for the internal nodes. `verifyRoot` is
// what checks the server was telling the truth.
//
// Paging over the chunk feed lives in `./chunk-feed.js`; this file only keeps
// the leaves in order.
//
// Persistence: pass a `TreePersistence` to `TreeStore.withPersistence`;
// `load` runs once at startup, `save` after every successful `sync()`.

import { WireFormatError } from "../core/errors.js";
import type { Field, Poseidon } from "../crypto/index.js";
import { type MerkleNode, type MerkleProof, MerkleTree } from "../crypto/merkle.js";
import type { IsKnownRoot } from "../crypto/path.js";
import { getLogger } from "../log/logger.js";
import type { FmdClient } from "../services/fmd-server/client.js";
import {
    chunkOf,
    maxChunksFor,
    type PagingOpts,
    type PagingStop,
    pageChunks,
    TREE_DEPTH,
} from "./chunk-feed.js";

// Re-exported because `TreeStoreState.nodes` is typed by it: a
// `TreePersistence` implementation cannot be written without naming it.
export type { MerkleNode };

const log = getLogger("lelantos:wallet:tree");

export interface TreeStoreState {
    leaves: bigint[];
    syncedCount: number;
    /**
     * Memoized internal Merkle nodes.
     *
     * Optional: a state without them still loads, it just pays the full
     * ~350K-hash rebuild on the first `root()`/`getPath()` after restore.
     */
    nodes?: MerkleNode[] | undefined;
}

/**
 * Plug in any storage backend to persist the Merkle tree across page loads.
 *
 * @example
 * ```ts
 * class MyPersistence implements TreePersistence {
 *     async load() { return JSON.parse(localStorage.getItem("tree") ?? "null"); }
 *     async save(state) { localStorage.setItem("tree", JSON.stringify(state)); }
 *     async clear() { localStorage.removeItem("tree"); }
 * }
 * const wallet = await connect({ ..., treePersistence: new MyPersistence() });
 * ```
 */
export interface TreePersistence {
    load(): Promise<TreeStoreState | null>;
    save(state: TreeStoreState): Promise<void>;
    /**
     * Discard every record written for this tree.
     *
     * Required rather than optional, because a backend that cannot forget is
     * one {@link TreeStore.reset} cannot repair: the rebuild would live in
     * memory, `load()` would restore the discarded tree on the next start, and
     * the wallet would pay the rebuild again on every spend while only ever
     * logging a warning.
     */
    clear(): Promise<void>;
}

/**
 * What {@link TreeStore.verifyRoot} saw.
 *
 * `mirrorRoot`, not `chainRoot`: it comes from the commitment server, which
 * mirrors the chain rather than being it. The distinction is the whole reason
 * `spendable` exists — a mirror built at the wrong depth, or lagging, reports
 * a root the chain never held and condemns a local tree that is perfectly
 * good, so agreement with it is sufficient but not necessary.
 *
 * The leaf counts say *how* a tree disagrees, which decides how to repair it:
 * see {@link TreeStore.reset}.
 */
export interface RootCheck {
    /**
     * The tree is one the pool would accept a proof against.
     *
     * Not derivable from the roots: it is true when they agree, and also when
     * they do not but the chain itself vouched for the local root.
     */
    spendable: boolean;
    localRoot: Field;
    mirrorRoot: Field;
    localLeaves: number;
    mirrorLeaves: number;
}

export interface TreeVerifyOpts extends TreeSyncOpts {
    /**
     * Asks the pool whether it would accept the local root.
     *
     * Supplied by the caller because reaching the chain is a capability
     * `TreeStore` does not otherwise need; when to consult it stays here.
     */
    isKnownRoot?: IsKnownRoot | undefined;
}

export interface TreeSyncOpts extends PagingOpts {
    /** Per-chunk progress, so a stuck sync is observable. */
    onProgress?:
        | ((p: { chunkId: number; leaves: number; syncedCount: number }) => void)
        | undefined;
}

export interface TreeSyncSummary {
    chunksFetched: number;
    leavesAdded: number;
    syncedCount: number;
    stoppedBy: PagingStop;
}

export class TreeStore {
    private tree: MerkleTree;
    private syncedCount = 0;
    private persistence?: TreePersistence;

    /**
     * `treeDepth` must be the same value the spend path gives the circuit
     * (`WalletConfig.treeDepth`). A local tree of a different depth produces
     * paths and a root of that depth, the proof is built for another, and
     * nothing errors — the proof simply fails to verify on chain.
     */
    constructor(
        private readonly P: Poseidon,
        private readonly fmd: FmdClient,
        private readonly treeDepth: number = TREE_DEPTH,
    ) {
        this.tree = new MerkleTree(P, treeDepth);
    }

    /** Build a TreeStore and restore any previously persisted state. */
    static async withPersistence(
        P: Poseidon,
        fmd: FmdClient,
        persistence: TreePersistence,
        treeDepth: number = TREE_DEPTH,
    ): Promise<TreeStore> {
        const store = new TreeStore(P, fmd, treeDepth);
        store.persistence = persistence;
        const saved = await persistence.load();
        if (saved) store.loadState(saved);
        return store;
    }

    loadState(state: TreeStoreState): void {
        this.tree = new MerkleTree(this.P, this.treeDepth);
        // Order matters: `setLeaves` clears the node cache.
        this.tree.setLeaves(state.leaves);
        if (state.nodes) this.tree.importNodes(state.nodes);
        this.syncedCount = state.syncedCount;
    }

    saveState(): TreeStoreState {
        return {
            leaves: [...this.tree.leaves],
            syncedCount: this.syncedCount,
            nodes: this.tree.exportNodes(),
        };
    }

    /**
     * Fetch new chunks since last sync, insert their leaves, then persist.
     * Idempotent — the tail chunk is re-fetched every sync, so entries already
     * in the tree are dropped by leaf index rather than re-inserted.
     */
    async sync(opts: TreeSyncOpts = {}): Promise<TreeSyncSummary> {
        const startCount = this.syncedCount;

        try {
            const { chunksFetched, stoppedBy } = await pageChunks(
                (chunkId, signal) => this.fmd.fetchCommitmentChunk(chunkId, { signal }),
                chunkOf(this.syncedCount),
                (chunk) => {
                    const fresh = chunk.entries.filter((e) => e.leafIndex >= this.syncedCount);
                    if (fresh.length > 0) {
                        assertContiguous(fresh, this.tree.leaves.length, chunk.chunkId);
                        this.tree.bulkInsert(fresh.map((e) => e.leafHash));
                        this.syncedCount = fresh[fresh.length - 1]!.leafIndex + 1;
                    }
                    opts.onProgress?.({
                        chunkId: chunk.chunkId,
                        leaves: fresh.length,
                        syncedCount: this.syncedCount,
                    });
                },
                {
                    // Derived from the configured depth, not the module
                    // default: a deeper tree holds more leaves and so more
                    // chunks, and the ceiling has to follow it.
                    maxChunks: opts.maxChunks ?? maxChunksFor(this.treeDepth),
                    signal: opts.signal,
                    feed: "commitments",
                },
            );

            return {
                chunksFetched,
                leavesAdded: this.syncedCount - startCount,
                syncedCount: this.syncedCount,
                stoppedBy,
            };
        } finally {
            // In `finally`, and gated on the cursor rather than on success.
            //
            // A chunk failure mid-sync leaves every chunk consumed before it
            // already folded into `this.tree`, so the in-memory cursor has
            // moved even though the sync threw. Skipping the save there means
            // a reload re-downloads and re-hashes all of it — on a cold sync,
            // potentially the entire tree. Saving here turns that into a
            // resume.
            //
            // The guard is `syncedCount`, not `chunksFetched`: the tail chunk
            // is re-fetched every sync, so a steady-state poll always fetches
            // at least one chunk while adding no leaves, and serialising a
            // 1M-leaf tree for that is pure cost.
            if (this.syncedCount > startCount) {
                // Force the internal nodes to be built before snapshotting.
                //
                // The cache fills lazily on the first `root()`/`getPath()`, so
                // saving straight after a sync would persist an empty one and
                // the restore would gain nothing. Doing it here also moves the
                // hashing off the spend path — it happens while a sync is
                // already in progress and observable, rather than stalling the
                // first transaction the user tries to make.
                this.tree.root();
                await this.persistence?.save(this.saveState());
            }
        }
    }

    getPath(leafIndex: number): MerkleProof & { root: Field } {
        return { ...this.tree.proof(leafIndex), root: this.tree.root() };
    }

    root(): Field {
        return this.tree.root();
    }

    /**
     * Check the locally built root against the one the chain holds.
     *
     * Worth doing on its own merits — nothing verified the local tree before —
     * and it is the guard that makes trusting the server's `leafHash` sound:
     * a wrong leaf produces a wrong root, and this is where that surfaces,
     * rather than as an unexplained rejected transaction later.
     *
     * Reports what it saw rather than a verdict; {@link syncVerified} is what
     * acts on it.
     */
    async verifyRoot(): Promise<RootCheck> {
        const state = await this.fmd.fetchTreeState();
        const localRoot = this.root();
        return {
            spendable: state.root === localRoot,
            localRoot,
            mirrorRoot: state.root,
            localLeaves: this.tree.leaves.length,
            mirrorLeaves: state.leafCount,
        };
    }

    /**
     * Sync, then keep going until the tree the chain describes is the tree
     * this store holds.
     *
     * Lives here rather than in the caller because the repair needs `sync`,
     * `verifyRoot` and `reset` together, and every one of them is on this
     * class. A caller only has to ask whether the returned roots agree.
     *
     * Three passes, each cheaper than the one after it:
     *
     *   1. Sync and check. Settles it in the ordinary case.
     *   2. Repair according to what the counts say. Fewer leaves locally is a
     *      lag — the mirror moved while the tree was being built — and another
     *      sync appends what is missing. Otherwise there is nothing to append,
     *      so the cheap move is a second, independent read of the chain state:
     *      an equal count with a differing root is also what a `/v1/tree-state`
     *      and a chunk feed read microseconds apart look like, and one HTTP GET
     *      is worth spending to avoid pass 3.
     *   3. Ask the pool directly, when the caller supplied `isKnownRoot`. The
     *      mirror is not the authority, and this is the one question that
     *      cannot be wrong. A yes here means the tree was always fine and the
     *      mirror is the faulty party — which is worth one RPC round trip,
     *      because the alternative below costs every leaf again.
     *   4. Rebuild from leaf 0. What is left is a tree that really did
     *      diverge, and syncing cannot repair one: see {@link reset}.
     *
     * Only pass 4 is expensive, and it is reached only once all three cheap
     * answers have failed.
     */
    async syncVerified(opts: TreeVerifyOpts = {}): Promise<RootCheck> {
        await this.sync(opts);
        let check = await this.verifyRoot();
        if (check.spendable) return check;

        if (check.mirrorLeaves > check.localLeaves) {
            log.debug("local tree is behind the mirror; resyncing", counts(check));
            await this.sync(opts);
        } else {
            log.debug("local tree disagrees with the mirror; re-reading tree state", counts(check));
        }
        check = await this.verifyRoot();
        if (check.spendable) return check;

        if (await vouchedFor(opts.isKnownRoot, check.localRoot)) {
            log.warn(
                "commitment mirror disagrees with the chain, but the pool accepts the local " +
                    "root; spending against it and leaving the mirror to catch up",
                counts(check),
            );
            return { ...check, spendable: true };
        }

        log.warn("local tree diverges from the chain; rebuilding it from leaf 0", counts(check));
        await this.reset();
        await this.sync(opts);
        return this.verifyRoot();
    }

    /**
     * Throw the local tree away, along with anything persisted for it, so the
     * next `sync()` rebuilds from leaf 0.
     *
     * The escape hatch for a tree that cannot be repaired by syncing, and the
     * one place the reason is written down. `sync()` only appends: it pages
     * from `chunkOf(syncedCount)` and drops every entry below that cursor, so
     * a prefix that diverged from the chain — the server re-indexed, the pool
     * was redeployed under the same chain id, a partially written restore —
     * stays wrong no matter how many times it is re-run, and so does a local
     * tree holding more leaves than the chain does.
     *
     * Expensive: the rebuild re-fetches and re-hashes every leaf. Reach for it
     * only once an ordinary resync has failed to settle the disagreement,
     * which is what {@link syncVerified} does.
     */
    async reset(): Promise<void> {
        this.tree = new MerkleTree(this.P, this.treeDepth);
        this.syncedCount = 0;
        await this.persistence?.clear();
    }
}

/**
 * Ask the pool about `root`, treating every non-answer as "no".
 *
 * An adapter that cannot reach the chain, and a read that fails, are both
 * silence rather than permission — the mirror's verdict stands, and the caller
 * is already on its way to a typed error that says more than an RPC failure
 * would.
 */
async function vouchedFor(ask: IsKnownRoot | undefined, root: Field): Promise<boolean> {
    if (!ask) return false;
    try {
        return await ask(root);
    } catch (err) {
        log.debug("could not ask the pool about the local root", {
            error: err instanceof Error ? err.message : String(err),
        });
        return false;
    }
}

/**
 * One spelling of a mismatch for every log line and error context, so a search
 * for one of these fields finds all of them.
 */
function counts(check: RootCheck): Record<string, string | number> {
    return {
        localRoot: check.localRoot.toString(),
        mirrorRoot: check.mirrorRoot.toString(),
        localLeaves: check.localLeaves,
        mirrorLeaves: check.mirrorLeaves,
    };
}

/**
 * Reject a chunk whose leaves do not sit exactly where the tree expects them.
 *
 * `bulkInsert` appends, so position is implied by arrival order: `leafIndex`
 * is otherwise never read. A chunk that starts at the wrong index, or has a
 * gap in the middle, would place every following leaf one slot off and produce
 * a wrong Merkle root — with no error, and no symptom until a proof against
 * that root is rejected on chain.
 *
 * Cheap to check and the only thing making `leafIndex` load-bearing, so it is
 * checked rather than assumed.
 */
function assertContiguous(
    fresh: readonly { leafIndex: number }[],
    expectedFirst: number,
    chunkId: number,
): void {
    const first = fresh[0]!.leafIndex;
    const last = fresh[fresh.length - 1]!.leafIndex;
    if (first !== expectedFirst) {
        throw new WireFormatError(
            `$.entries[0].leafIndex`,
            `commitment chunk ${chunkId} starts at leaf ${first}, expected ${expectedFirst}`,
        );
    }
    if (last - first !== fresh.length - 1) {
        throw new WireFormatError(
            "$.entries",
            `commitment chunk ${chunkId} has a gap: leaves ${first}..${last} in ${fresh.length} entries`,
        );
    }
}
