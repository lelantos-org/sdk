// Defaulting rules for every omitted pluggable.
//
// `resolveConfig` is the single place they live, so `Wallet` can read the
// resolved config directly instead of re-asserting it.

import { DEFAULT_SHAPE } from "../../core/shape.js";
import type { Jubjub, Poseidon } from "../../crypto/index.js";
import { LocalScanner } from "../../sync/scanner.js";
import type { ResolvedWalletConfig, WalletConfig } from "../config.js";
import { InMemoryNoteStore } from "../note-store.js";
import { SfrtCoinSelector } from "../selection.js";
import {
    defaultFmdClient,
    defaultNoteSource,
    defaultNullifierStore,
    defaultSubmitter,
    defaultTreeStore,
} from "./pluggables.js";
import { defaultProver } from "./prover.js";

export { type ChainAdapterInputs, defaultChainAdapter } from "./chain.js";
export {
    defaultFmdClient,
    defaultNoteSource,
    defaultNullifierStore,
    defaultSubmitter,
    defaultTreeStore,
} from "./pluggables.js";
export { buildConnectProver, defaultProver, type ProverBuildInputs } from "./prover.js";
export { validateConfig } from "./validate.js";

export async function resolveConfig(
    cfg: WalletConfig,
    deps: { P: Poseidon; J: Jubjub },
): Promise<ResolvedWalletConfig> {
    const fmd = defaultFmdClient(cfg);
    return {
        ...cfg,
        shape: cfg.shape ?? DEFAULT_SHAPE,
        noteStore: cfg.noteStore ?? new InMemoryNoteStore(),
        noteSource: cfg.noteSource ?? defaultNoteSource(fmd, cfg, deps.J),
        treeStore: cfg.treeStore ?? (await defaultTreeStore(fmd, deps.P, cfg.treePersistence)),
        nullifierStore:
            cfg.nullifierStore ?? (await defaultNullifierStore(fmd, cfg.nullifierPersistence)),
        submitter: cfg.submitter ?? defaultSubmitter(cfg),
        prover: cfg.prover ?? (await defaultProver(cfg)),
        selector: cfg.selector ?? new SfrtCoinSelector(),
        scanner: cfg.scanner ?? new LocalScanner(deps.J),
    };
}
