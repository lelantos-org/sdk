// Local Merkle tree store: syncs commitment chunks from the server and computes Merkle paths
// without revealing which note is being spent.
//
// Leaves arrive pre-hashed as `Poseidon(TAG_LEAF, cm, cv_dep_x, cv_dep_y)`, so `Poseidon` is used
// only for internal nodes. `verifyRoot` checks the server-provided leaves against the chain root.
//
// Paging lives in `./chunk-feed.js`; this file keeps the leaves in order.
//
// Persistence: pass a `TreePersistence` to `TreeStore.withPersistence`; `load` runs once at
// startup, `save` after each successful `sync()` that adds leaves.
//
// Concurrency: `sync`, `reset`, `syncVerified` and `syncVerifiedSnapshot` share one lock. A reset
// racing a paging sync would otherwise hand the sync an empty tree mid-page (a spurious
// `WireFormatError` for a non-contiguous chunk), and a spend could read a root and paths from two
// different trees.

import { createMutex } from "../core/async.js";
import type { Field, Poseidon } from "../crypto/index.js";
import { type MerkleNode, type MerkleProof, MerkleTree } from "../crypto/merkle.js";
import type { IsKnownRoot } from "../crypto/path.js";
import { errMessage } from "../errors/base.js";
import { EnvironmentError } from "../errors/config.js";
import { WireFormatError } from "../errors/network.js";
import { getLogger } from "../log/logger.js";
import type { CommitmentChunkOut, FmdTreeState } from "../services/fmd-server/wire.js";
import {
    chunkOf,
    maxChunksFor,
    type PagingOpts,
    type PagingStop,
    pageChunks,
    TREE_DEPTH,
} from "./chunk-feed.js";

// Re-exported because `TreeStoreState.nodes` uses it, so `TreePersistence` implementations need it.
export type { MerkleNode };

const log = getLogger("lelantos:wallet:tree");

export interface TreeStoreState {
    leaves: bigint[];
    syncedCount: number;
    /**
     * Memoized internal Merkle nodes.
     *
     * Optional: a state without them loads but incurs a full ~350K-hash rebuild on the first
     * `root()`/`getPath()` after restore.
     */
    nodes?: MerkleNode[] | undefined;
}

/**
 * Storage backend that persists the Merkle tree across page loads.
 *
 * `TreeStoreState.leaves` is `bigint[]`, which `JSON.stringify` cannot serialise, so a JSON backend
 * must encode it. Use `0x`-prefixed hex: `BigInt` parses unprefixed strings as decimal, so bare hex
 * with only decimal digits would decode to a different number. A structured-clone backend
 * (IndexedDB) stores `bigint` directly.
 *
 * @example
 * ```ts
 * class MyPersistence implements TreePersistence {
 *     async load() {
 *         const raw = localStorage.getItem("tree");
 *         if (raw === null) return null;
 *         const { leaves, syncedCount } = JSON.parse(raw) as {
 *             leaves: string[];
 *             syncedCount: number;
 *         };
 *         return { leaves: leaves.map(BigInt), syncedCount };
 *     }
 *     async save(state: TreeStoreState) {
 *         localStorage.setItem(
 *             "tree",
 *             JSON.stringify({
 *                 leaves: state.leaves.map((v) => `0x${v.toString(16)}`),
 *                 syncedCount: state.syncedCount,
 *             }),
 *         );
 *     }
 *     async clear() { localStorage.removeItem("tree"); }
 * }
 * const wallet = await connect({ ..., storage: { tree: new MyPersistence() } });
 * ```
 *
 * The example omits `nodes` on save, which is valid; see {@link TreeStoreState.nodes} for the cost.
 */
export interface TreePersistence {
    load(): Promise<TreeStoreState | null>;
    save(state: TreeStoreState): Promise<void>;
    /**
     * Discard every record written for this tree.
     *
     * Required because {@link TreeStore.reset} depends on it: otherwise `load()` would restore the
     * discarded tree on the next start and the rebuild would repeat on every spend.
     */
    clear(): Promise<void>;
}

/**
 * Where a {@link TreeStore} reads the commitment tree from: chunked leaves and the mirror's head.
 * `FmdClient` implements it; any source serving the same chunks can stand in.
 */
export interface CommitmentFeed {
    fetchCommitmentChunk(
        chunkId: number,
        opts?: { signal?: AbortSignal | undefined },
    ): Promise<CommitmentChunkOut>;
    fetchTreeState(): Promise<FmdTreeState>;
}

/**
 * Result of {@link TreeStore.verifyRoot}.
 *
 * `mirrorRoot` comes from the commitment server, which mirrors the chain. A lagging mirror or one
 * built at the wrong depth can report a root the chain never held, so agreement with it is
 * sufficient but not necessary for `spendable`.
 *
 * The leaf counts indicate how the trees disagree, which determines the repair; see
 * {@link TreeStore.reset}.
 */
export interface RootCheck {
    /**
     * Whether the pool would accept a proof against the local tree.
     *
     * True when the roots agree, or when they differ but the chain accepts the local root.
     */
    spendable: boolean;
    localRoot: Field;
    mirrorRoot: Field;
    localLeaves: number;
    mirrorLeaves: number;
}

export interface TreeVerifyOpts extends TreeSyncOpts {
    /**
     * Asks the pool whether it would accept the local root. Supplied by the caller because
     * `TreeStore` has no chain access of its own.
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
    /** Serialises every mutation, and the save that follows it. See the file header. */
    private readonly lock = createMutex();
    /** `syncedCount` as of the last successful save or load. */
    private savedCount = 0;

    /**
     * `treeDepth` must equal the depth the spend path gives the circuit (`WalletConfig.treeDepth`).
     * A mismatched depth raises no local error, but the proof fails to verify on-chain.
     */
    constructor(
        private readonly P: Poseidon,
        private readonly fmd: CommitmentFeed,
        private readonly treeDepth: number = TREE_DEPTH,
    ) {
        this.tree = new MerkleTree(P, treeDepth);
    }

    /** Build a TreeStore and restore any previously persisted state. */
    static async withPersistence(
        P: Poseidon,
        fmd: CommitmentFeed,
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
        this.savedCount = state.syncedCount;
    }

    saveState(): TreeStoreState {
        return {
            leaves: [...this.tree.leaves],
            syncedCount: this.syncedCount,
            nodes: this.tree.exportNodes(),
        };
    }

    /**
     * Fetch chunks since the last sync, insert their leaves, then persist. Idempotent: the tail
     * chunk is re-fetched every sync and existing entries are skipped by leaf index.
     *
     * Runs after any sync, reset or verification already in progress.
     */
    async sync(opts: TreeSyncOpts = {}): Promise<TreeSyncSummary> {
        return this.lock.run(() => this.syncUnlocked(opts));
    }

    private async syncUnlocked(opts: TreeSyncOpts): Promise<TreeSyncSummary> {
        const startCount = this.syncedCount;

        const { chunksFetched, stoppedBy } = await pageChunks(
            (chunkId, signal) => this.fmd.fetchCommitmentChunk(chunkId, { signal }),
            chunkOf(this.syncedCount),
            (chunk) => {
                const fresh = chunk.entries.filter((e) => e.leafIndex >= this.syncedCount);
                if (fresh.length > 0) {
                    assertContiguous(fresh, this.tree.leaves.length, chunk.chunkId);
                    this.tree.bulkInsert(fresh.map((e) => e.leafHash));
                    this.syncedCount = fresh.at(-1)!.leafIndex + 1;
                }
                opts.onProgress?.({
                    chunkId: chunk.chunkId,
                    leaves: fresh.length,
                    syncedCount: this.syncedCount,
                });
            },
            {
                // Derived from the configured depth, since a deeper tree has more chunks.
                maxChunks: opts.maxChunks ?? maxChunksFor(this.treeDepth),
                signal: opts.signal,
                feed: "commitments",
            },
        );

        // Saved only after the sync succeeds, and under the lock, so saves land in order and a
        // failed save can never replace the error of a failed sync. A mid-sync failure keeps the
        // leaves already folded in memory; the next successful sync persists them, which is why
        // this compares against what was last saved rather than against `startCount`.
        //
        // Gated on the cursor, not `chunksFetched`: a steady-state poll re-fetches the tail chunk
        // without adding leaves, and serialising a 1M-leaf tree then is wasted work.
        if (this.syncedCount !== this.savedCount) await this.persist();

        return {
            chunksFetched,
            leavesAdded: this.syncedCount - startCount,
            syncedCount: this.syncedCount,
            stoppedBy,
        };
    }

    /** Write the current tree to persistence, if configured. Caller holds the lock. */
    private async persist(): Promise<void> {
        if (!this.persistence) return;
        // Build the internal nodes before snapshotting. The node cache fills lazily, so saving
        // without this would persist an empty cache; it also moves the hashing off the first
        // spend and into the sync.
        this.tree.root();
        try {
            await this.persistence.save(this.saveState());
            this.savedCount = this.syncedCount;
        } catch (err) {
            throw new EnvironmentError(
                `tree persistence failed to save ${this.syncedCount} leaves; the in-memory tree ` +
                    "is current, but a reload would resume from the last saved state",
                { cause: err },
            );
        }
    }

    getPath(leafIndex: number): MerkleProof & { root: Field } {
        return { ...this.tree.proof(leafIndex), root: this.tree.root() };
    }

    root(): Field {
        return this.tree.root();
    }

    /**
     * Check the locally built root against the mirrored chain root.
     *
     * This check makes trusting the server's `leafHash` sound: a wrong leaf produces a wrong root,
     * which surfaces here rather than as a rejected transaction.
     *
     * Reports observations only; {@link syncVerified} acts on them.
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
     * Sync, then repair until the local tree matches the chain.
     *
     * Passes, in increasing cost:
     *
     *   1. Sync and check; sufficient in the ordinary case.
     *   2. If the mirror has more leaves, the local tree lags and another sync appends the rest.
     *      Otherwise re-read the tree state, since an equal count with a differing root also
     *      results from `/v1/tree-state` and the chunk feed being read at slightly different
     *      times.
     *   3. If `isKnownRoot` is supplied, ask the pool directly, which is authoritative. If it
     *      accepts the local root, the mirror is at fault and the tree is spendable.
     *   4. Rebuild from leaf 0, since syncing cannot repair a diverged tree; see {@link reset}.
     *
     * Only pass 4 is expensive, and it runs only after the others fail.
     */
    async syncVerified(opts: TreeVerifyOpts = {}): Promise<RootCheck> {
        return this.lock.run(() => this.syncVerifiedUnlocked(opts));
    }

    /**
     * {@link syncVerified}, then `read` against the verified tree, with no sync or reset in
     * between.
     *
     * For a spend, which needs its Merkle root and every input's path taken from one tree: read
     * separately, a concurrent sync or reset could change the root between them.
     */
    async syncVerifiedSnapshot<T>(
        opts: TreeVerifyOpts,
        read: (check: RootCheck) => T | Promise<T>,
    ): Promise<{ check: RootCheck; value: T | undefined }> {
        return this.lock.run(async () => {
            const check = await this.syncVerifiedUnlocked(opts);
            return { check, value: check.spendable ? await read(check) : undefined };
        });
    }

    private async syncVerifiedUnlocked(opts: TreeVerifyOpts): Promise<RootCheck> {
        await this.syncUnlocked(opts);
        let check = await this.verifyRoot();
        if (check.spendable) return check;

        if (check.mirrorLeaves > check.localLeaves) {
            log.debug("local tree is behind the mirror; resyncing", counts(check));
            await this.syncUnlocked(opts);
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
        await this.resetUnlocked();
        await this.syncUnlocked(opts);
        return this.verifyRoot();
    }

    /**
     * Discard the local tree and its persisted state so the next `sync()` rebuilds from leaf 0.
     *
     * For trees that syncing cannot repair. `sync()` only appends from `chunkOf(syncedCount)`, so a
     * prefix that diverged from the chain (server re-index, pool redeployed under the same chain
     * id, partially written restore) stays wrong, as does a local tree with more leaves than the
     * chain.
     *
     * Expensive: every leaf is re-fetched and re-hashed. Use only after an ordinary resync fails,
     * as {@link syncVerified} does.
     */
    async reset(): Promise<void> {
        return this.lock.run(() => this.resetUnlocked());
    }

    private async resetUnlocked(): Promise<void> {
        this.tree = new MerkleTree(this.P, this.treeDepth);
        this.syncedCount = 0;
        this.savedCount = 0;
        await this.persistence?.clear();
    }
}

/**
 * Ask the pool whether it accepts `root`, treating any failure as "no".
 *
 * A missing adapter or a failed read leaves the mirror's result in place, and the caller reports a
 * typed error that is more informative than the RPC failure.
 */
async function vouchedFor(ask: IsKnownRoot | undefined, root: Field): Promise<boolean> {
    if (!ask) return false;
    try {
        return await ask(root);
    } catch (err) {
        log.debug("could not ask the pool about the local root", {
            error: errMessage(err),
        });
        return false;
    }
}

/** Consistent mismatch fields for log lines and error contexts. */
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
 * `bulkInsert` appends, so position is implied by arrival order and `leafIndex` is read only here.
 * A chunk starting at the wrong index or containing a gap would shift every following leaf and
 * produce a wrong Merkle root, detected only when a proof is rejected on-chain.
 */
function assertContiguous(
    fresh: readonly { leafIndex: number }[],
    expectedFirst: number,
    chunkId: number,
): void {
    const first = fresh[0]!.leafIndex;
    const last = fresh.at(-1)!.leafIndex;
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
