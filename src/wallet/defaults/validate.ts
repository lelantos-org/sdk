// Config validation. Collects every problem into one error rather than
// failing on the first, so a caller fixes their wiring in one pass.

import { WalletConfigError } from "../../core/errors.js";
import type { WalletConfig } from "../config.js";

export function validateConfig(cfg: WalletConfig): void {
    const missing: string[] = [];
    if (cfg.chainId === undefined || cfg.chainId === null) missing.push("`chainId`");
    if (!cfg.relayerAddress) missing.push("`relayerAddress`");
    if (!cfg.chain) missing.push("`chain` (ChainAdapter)");
    if (cfg.treeDepth === undefined || cfg.treeDepth <= 0) missing.push("`treeDepth`");
    if (!cfg.noteSource && !cfg.fmdUrl) missing.push("`fmdUrl` (or `noteSource`)");
    if (!cfg.submitter && !cfg.relayerUrl) missing.push("`relayerUrl` (or `submitter`)");
    if (missing.length) throw new WalletConfigError(missing);
}
