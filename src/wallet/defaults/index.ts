// Defaulting rules for every omitted pluggable. `resolveConfig` is their single source, so the
// wallet reads the resolved config without re-checking it.

import type { Jubjub, Poseidon } from "../../crypto/index.js";
import { DEFAULT_SHAPE } from "../../protocol/shape.js";
import { LocalScanner } from "../../sync/scanner.js";
import { InMemoryNoteStore } from "../notes/note-store.js";
import { SfrtCoinSelector } from "../selection/index.js";
import type { ResolvedWalletConfig, WalletConfig } from "../types/config.js";
import {
    defaultNoteSource,
    defaultNullifierStore,
    defaultSubmitter,
    defaultTreeStore,
    lazyFmdClient,
} from "./pluggables.js";
import { buildProverHandle, type ProverHandle } from "./prover.js";

/** The prover handle `cfg.prover` describes; lazy, so building it does no I/O. */
export function proverHandleFor(cfg: WalletConfig): ProverHandle {
    return buildProverHandle(cfg.prover, { shape: cfg.shape });
}

/**
 * Fill in every omitted pluggable, producing the config the wallet runs on.
 *
 * `deps.prover` is the handle already built for `cfg.prover`; without it one is built here.
 */
export async function resolveConfig(
    cfg: WalletConfig,
    deps: { P: Poseidon; J: Jubjub; prover?: ProverHandle | undefined },
): Promise<ResolvedWalletConfig> {
    const fmdClient = lazyFmdClient(cfg);
    const { prover: _option, ...rest } = cfg;
    // Each default store restores its persisted state; the two reads are independent.
    const [treeStore, nullifierStore] = await Promise.all([
        cfg.treeStore ?? defaultTreeStore(fmdClient(), deps.P, cfg.treePersistence, cfg.treeDepth),
        cfg.nullifierStore ?? defaultNullifierStore(fmdClient(), cfg.nullifierPersistence),
    ]);

    return {
        ...rest,
        shape: cfg.shape ?? DEFAULT_SHAPE,
        noteStore: cfg.noteStore ?? new InMemoryNoteStore(),
        noteSource: cfg.noteSource ?? defaultNoteSource(fmdClient(), cfg),
        treeStore,
        nullifierStore,
        submitter: cfg.submitter ?? defaultSubmitter(cfg),
        prover: (deps.prover ?? proverHandleFor(cfg)).prover,
        selector: cfg.selector ?? new SfrtCoinSelector(),
        scanner: cfg.scanner ?? new LocalScanner(deps.J, deps.P),
    };
}
