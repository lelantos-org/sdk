// DEPRECATED: tree_update.circom is removed from the project. This module
// stays as a thin shim only so existing SDK consumers (wallet, operator,
// relayer) continue to compile. New code should target
// `tree-update-batch.ts` (when materialized) or build the
// `tree_update_batch` witness directly. These helpers produce the legacy
// 5-coeff PolyEval input shape which no contract entry consumes anymore.

import type { Field } from "../crypto/index.js";
import { fiatShamirZ, flattenTreeUpdate, hornerEval } from "../snark-compression.js";

export interface TreeUpdateBuildOpts {
    oldRoot: Field;
    newRoot: Field;
    cm0: Field;
    cm1: Field;
    startIndex: number | bigint;
    frontier: Field[][];
    z?: Field;
}

/** @deprecated tree_update.circom removed. Migrate to tree_update_batch witnesses. */
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

/** @deprecated tree_update.circom removed. Use tree_update_batch compression. */
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
