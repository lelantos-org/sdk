// Config validation. Collects every problem into one error rather than
// failing on the first, so a caller fixes their wiring in one pass.

import { WalletConfigError } from "../../core/errors.js";
import type { WalletConfig } from "../config.js";

/**
 * Upper bound on `treeDepth`. `4 ** 24` leaves is already far past anything
 * deployable, and it keeps `maxChunksFor` inside safe-integer range.
 */
const MAX_TREE_DEPTH = 24;

export function validateConfig(cfg: WalletConfig): void {
    const missing: string[] = [];
    if (cfg.chainId === undefined || cfg.chainId === null) missing.push("`chainId`");
    if (!cfg.relayerAddress) missing.push("`relayerAddress`");
    if (!cfg.chain) missing.push("`chain` (ChainAdapter)");
    // Integral and bounded, not merely positive. `treeDepth` sizes the local
    // MerkleTree and is handed to the circuit, and `4 ** treeDepth` is the leaf
    // capacity — a fractional or absurd value yields a tree nothing can
    // reconcile, far from where it was set.
    if (
        cfg.treeDepth === undefined ||
        !Number.isInteger(cfg.treeDepth) ||
        cfg.treeDepth <= 0 ||
        cfg.treeDepth > MAX_TREE_DEPTH
    ) {
        missing.push(`\`treeDepth\` (integer in 1..${MAX_TREE_DEPTH})`);
    }
    if (!cfg.noteSource && !cfg.fmdUrl) missing.push("`fmdUrl` (or `noteSource`)");
    if (!cfg.submitter && !cfg.relayerUrl) missing.push("`relayerUrl` (or `submitter`)");
    if (missing.length) throw new WalletConfigError(missing);
}
