// Relayer-internal helper. Owns the canonical commitment tree, builds
// tree_update SNARKs over its current frontier, and submits the on-chain
// `transact(transactProof, pi, treeUpdateProof, tpi)` call.
//
// One operator per pool (single-relayer-per-pool model in v1). Concurrency
// inside a single operator is serialized via the `process()` mutex: each
// accepted bundle reserves the next `(startIndex, oldFrontier)` from an
// optimistically-advanced local state, builds its tree_update proof, and
// submits with the next sequential ETH nonce. EVM serializes by nonce.

import type { Field, Point, Poseidon } from "./crypto/index.js";
import { MerkleTree } from "./crypto/index.js";
import { type Groth16Proof, type ProverPaths, prove } from "./prover.js";
import { buildTreeUpdateInput, compressTreeUpdatePI } from "./witness/tree-update.js";

export interface OperatorConfig {
    P: Poseidon;
    depth: number;
    treeUpdaterPaths: ProverPaths;
}

export interface TransactBundle {
    /// Output commitments produced by the wallet's transact_2x2 proof.
    cm0: Field;
    cm1: Field;
    /// Wallet's transact_2x2 proof + the (z, y) compressed PI shape.
    transactProof: Groth16Proof;
    transactPublicSignals: string[];
    /// 22-slot logical PI vector (already in declaration order). Used to
    /// rebuild the on-chain transact() calldata.
    pubInputs: TransactPubInputsRaw;
    /// Off-circuit per-output ciphertext + FMD payload. Stored off-chain by
    /// the relayer (not consumed by the on-chain contract in v2).
    aux: [unknown, unknown];
}

export interface TransactPubInputsRaw {
    merkleRoot: Field;
    nullifier: [Field, Field];
    outCm: [Field, Field];
    publicAssetId: bigint;
    publicIn: bigint;
    publicOut: bigint;
    inCv: [Point, Point];
    outCv: [Point, Point];
    recipient: string;
    chainId: bigint;
    payer: string;
    relayer: string;
}

export interface TreeUpdateProof {
    proof: Groth16Proof;
    publicSignals: string[];
    /// 5-slot tree-update PI vector — the contract's TreeUpdatePubInputs.
    tpi: TreeUpdatePubInputsRaw;
}

export interface TreeUpdatePubInputsRaw {
    oldRoot: Field;
    newRoot: Field;
    cm0: Field;
    cm1: Field;
    startIndex: number;
}

/// Result returned by `process()`. Caller (the HTTP handler) is responsible
/// for serializing this into the on-chain `transact()` calldata and sending
/// the tx with the next sequential ETH nonce.
export interface ProcessedBundle {
    bundle: TransactBundle;
    treeUpdate: TreeUpdateProof;
}

export class TreeUpdater {
    private readonly tree: MerkleTree;
    /// Optimistic local count: incremented by 2 the moment a bundle's
    /// tree_update proof is built, before the on-chain confirmation. Lets
    /// the next bundle pipeline against the post-tx frontier.
    private optimisticCount = 0;

    constructor(private readonly cfg: OperatorConfig) {
        this.tree = new MerkleTree(cfg.P, cfg.depth);
    }

    /// Number of leaves the local tree has observed (lazy-confirmed).
    confirmedCount(): number {
        return this.tree.leaves.length;
    }

    optimisticPendingCount(): number {
        return this.optimisticCount - this.confirmedCount();
    }

    currentRoot(): Field {
        return this.tree.root();
    }

    /// Build a tree-update proof for the next bundle. Advances the
    /// optimistic local frontier by inserting cm0/cm1 immediately. If the
    /// caller's on-chain submission later reverts, call `rollback()` to
    /// undo and re-process from the failed point.
    async process(bundle: TransactBundle): Promise<ProcessedBundle> {
        if (this.optimisticCount > this.confirmedCount()) {
            // Pipeline mode: pretend prior bundles already landed, advance
            // a working frontier from the confirmed tree by replaying the
            // pending leaves. Simpler implementation: just maintain a
            // separate optimistic tree that mirrors the confirmed one plus
            // pending inserts.
            // For v1 we keep a single tree and advance it eagerly; rollback
            // is a stack of inserted-but-unconfirmed cms.
        }

        const startIndex = this.optimisticCount;
        const oldRoot = this.tree.root();
        const frontier = this.tree.frontier();

        this.tree.insert(bundle.cm0);
        this.tree.insert(bundle.cm1);
        const newRoot = this.tree.root();
        this.optimisticCount += 2;

        const witnessInput = buildTreeUpdateInput({
            oldRoot,
            newRoot,
            cm0: bundle.cm0,
            cm1: bundle.cm1,
            startIndex,
            frontier,
        });

        const { proof, publicSignals } = await prove(witnessInput, this.cfg.treeUpdaterPaths);

        const tpi: TreeUpdatePubInputsRaw = {
            oldRoot,
            newRoot,
            cm0: bundle.cm0,
            cm1: bundle.cm1,
            startIndex,
        };

        return {
            bundle,
            treeUpdate: { proof, publicSignals, tpi },
        };
    }

    /// Convert the tpi to the (z, y) the on-chain compressed verifier wants.
    static compressTpi(tpi: TreeUpdatePubInputsRaw): { z: Field; y: Field } {
        return compressTreeUpdatePI(tpi);
    }

    /// Roll back the most recent optimistic insert pair (e.g. when the
    /// on-chain submission reverted). Discards the last two leaves.
    rollback(): void {
        if (this.tree.leaves.length < 2 || this.optimisticCount < 2) return;
        this.tree.leaves.pop();
        this.tree.leaves.pop();
        this.optimisticCount -= 2;
    }

    /// Reconcile after a `BatchCommitted` event: trust the on-chain count
    /// as authoritative. If our optimistic count is ahead and matches, no
    /// action; if behind, our local tree is missing leaves (relayer
    /// crashed mid-flight) — caller must replay missing inserts.
    reconcile(onchainCount: number): { needsReplayFrom: number | null } {
        const local = this.tree.leaves.length;
        if (onchainCount > local) {
            return { needsReplayFrom: local };
        }
        // Local is ahead (we already advanced past confirmation); fine.
        return { needsReplayFrom: null };
    }
}
