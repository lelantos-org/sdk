// Config validation. Collects every problem into one error rather than failing
// on the first.

import { WalletConfigError } from "../../errors/config.js";
import { MAX_TREE_DEPTH } from "../constants.js";
import type { WalletConfig } from "../types/config.js";

export function validateConfig(cfg: WalletConfig): void {
    const missing: string[] = [];
    if (cfg.chainId === undefined || cfg.chainId === null) missing.push("`chainId`");
    if (!cfg.relayerAddress) missing.push("`relayerAddress`");
    if (!cfg.chain) missing.push("`chain` (ChainAdapter)");
    // Integral and bounded. `treeDepth` sizes the local MerkleTree and is passed
    // to the circuit (`4 ** treeDepth` leaves); an invalid value yields a tree
    // that cannot reconcile, with the failure far from the config.
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
