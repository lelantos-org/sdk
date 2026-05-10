// Default pluggable factories + up-front config validation. Keeps the
// `Wallet` class focused on flow, not on stitching defaults.

import type { Jubjub } from "../crypto/index.js";
import { bundledProverArtifacts, type ProverPaths, resolveArtifacts } from "../prover.js";
import type { WalletConfig } from "./config.js";
import { WalletConfigError } from "./errors.js";
import { FmdClient } from "./fmd-client.js";
import { FmdMatchesNoteSource, FmdNoteSource, type NoteSource } from "./note-source.js";
import { type Prover, SnarkjsProver } from "./prover.js";
import { HttpRelayerSubmitter, type Submitter } from "./submitter.js";

/// Aggregate up-front config validation. Thrown error lists every problem
/// at once so callers don't have to round-trip per missing field.
///
/// `prover`/`proverPaths` are NOT required: when omitted, `defaultProver`
/// resolves bundled artifacts via `bundledProverArtifacts()`. Validation
/// here only catches transport-layer omissions.
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

export function defaultNoteSource(cfg: WalletConfig, J: Jubjub): NoteSource {
    const fmd = new FmdClient(cfg.fmdUrl as string, cfg.chainId);
    if (cfg.syncStrategy?.kind === "matches") {
        return new FmdMatchesNoteSource({
            fmd,
            J,
            subscriptionId: cfg.syncStrategy.subscriptionId,
        });
    }
    return new FmdNoteSource({ fmd, J });
}

export function defaultSubmitter(cfg: WalletConfig): Submitter {
    return new HttpRelayerSubmitter(cfg.relayerUrl as string);
}

/// Builds the default snarkjs prover. When `cfg.proverPaths` is set,
/// uses it verbatim. When unset, resolves bundled artifacts via
/// `bundledProverArtifacts()` — companion package on Node, jsDelivr
/// CDN URLs in browser. Throws `ProverArtifactsMissingError` with
/// actionable guidance when nothing resolves.
export async function defaultProver(cfg: WalletConfig): Promise<Prover> {
    if (cfg.proverPaths) return new SnarkjsProver(cfg.proverPaths);
    const artifacts = await bundledProverArtifacts();
    return new SnarkjsProver(resolveArtifacts(artifacts) as ProverPaths);
}
