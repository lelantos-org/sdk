// Deterministic scalars for suites and vector builders whose counts and bytes must reproduce.

import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";

/** A 128-bit LCG seeded with `seed`, each draw mapped into `[1, q - 1]`. */
export function lcgScalars(seed: bigint): () => bigint {
    let s = seed;
    return () => {
        s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 128n) - 1n);
        return (s % (BABYJUB_SUBGROUP_ORDER - 1n)) + 1n;
    };
}
