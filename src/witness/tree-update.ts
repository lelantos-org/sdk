// Witness builder for the tree_update circuit. Mirrors
// circuits/src/tree_update.circom byte-for-byte: the relayer feeds the
// frontier its local MerkleTree exposes, plus cm0/cm1/startIndex/oldRoot/
// newRoot pulled from the tree before vs after the two inserts.
//
// The circuit recomputes start_index decompositions internally, so callers
// only need to pass the integer index — no path_indices field.

import type { Field } from "../crypto/index.js";
import { fiatShamirZ, flattenTreeUpdate, hornerEval } from "../snark-compression.js";

export interface TreeUpdateBuildOpts {
    oldRoot: Field;
    newRoot: Field;
    cm0: Field;
    cm1: Field;
    startIndex: number | bigint;
    /// Depth × 3 frontier from the relayer's local MerkleTree. Slot k at
    /// level lvl is read by the circuit only when k < (startIndex/4^lvl)%4;
    /// other slots may be 0 but MUST be supplied.
    frontier: Field[][];
    /// Optional Fiat-Shamir challenge. In production the contract derives
    /// `z` deterministically from the 5 logical PIs; tests can pass any
    /// value (the circuit will compute the matching `y` regardless).
    z?: Field;
}

export function buildTreeUpdateInput(
    opts: TreeUpdateBuildOpts,
): Record<string, string | string[][]> {
    const { oldRoot, newRoot, cm0, cm1, frontier } = opts;
    const startIndex = BigInt(opts.startIndex);
    const z =
        opts.z ??
        fiatShamirZ(
            flattenTreeUpdate({
                old_root: oldRoot,
                new_root: newRoot,
                cm0,
                cm1,
                start_index: startIndex,
            }),
        );

    return {
        z: z.toString(),
        old_root: oldRoot.toString(),
        new_root: newRoot.toString(),
        cm0: cm0.toString(),
        cm1: cm1.toString(),
        start_index: startIndex.toString(),
        frontier_in: frontier.map((lvl) => lvl.map((s) => s.toString())),
    };
}

/// Derive `(z, y)` for the contract's compressed verifier interface.
/// The circuit consumes `z` as a public input and emits `y = horner(coeffs, z)`
/// as its sole public output. This helper re-runs the same evaluation off-
/// chain so callers can build the on-chain `verifyProof` call without going
/// through snarkjs.
export function compressTreeUpdatePI(
    opts: Pick<TreeUpdateBuildOpts, "oldRoot" | "newRoot" | "cm0" | "cm1" | "startIndex">,
): { z: Field; y: Field } {
    const coeffs = flattenTreeUpdate({
        old_root: opts.oldRoot,
        new_root: opts.newRoot,
        cm0: opts.cm0,
        cm1: opts.cm1,
        start_index: BigInt(opts.startIndex),
    });
    const z = fiatShamirZ(coeffs);
    const y = hornerEval(coeffs, z);
    return { z, y };
}
