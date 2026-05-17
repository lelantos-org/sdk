// Default pluggable factories + up-front config validation. All
// default-resolution lives here so `connect.ts` can stay a thin
// parse → `WalletConfig` → `Wallet.create` pipeline.

import type { ChainAdapter } from "../chain/adapter.js";
import {
    type Eip1193ProviderLike,
    Eip1193Signer,
    type EthSigner,
    PrivateKeySigner,
} from "../chain/eth-signer.js";
import type { DeployedNetworkPreset } from "../chain/networks.js";
import { ViemChainAdapter } from "../chain/viem-adapter.js";
import type { Jubjub } from "../crypto/index.js";
import type { ProverArtifacts } from "../prover/artifacts.js";
import type { Prover } from "../prover/interface.js";
import { SnarkjsProver } from "../prover/interface.js";
import type { ProverPaths } from "../prover/snarkjs.js";
import { bundledProverArtifacts, resolveArtifacts } from "../prover/snarkjs.js";
import type { WalletConfig } from "./config.js";
import { WalletConfigError } from "./errors.js";
import { FmdClient } from "./fmd-client.js";
import { FmdMatchesNoteSource, FmdNoteSource, type NoteSource } from "./note-source.js";
import { HttpRelayerSubmitter, type Submitter } from "./submitter.js";

/// Aggregate validation; collects every problem before throwing. Skips
/// prover validation — `defaultProver` resolves bundled artifacts.
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

/// Default snarkjs prover. Uses `cfg.proverPaths` if set, else resolves
/// via `bundledProverArtifacts()`. Throws `ProverArtifactsMissingError`
/// when nothing resolves.
export async function defaultProver(cfg: WalletConfig): Promise<Prover> {
    if (cfg.proverPaths) return new SnarkjsProver(cfg.proverPaths);
    const artifacts = await bundledProverArtifacts();
    return new SnarkjsProver(resolveArtifacts(artifacts) as ProverPaths);
}

/// Inputs `connect()` collects to wire the default `ViemChainAdapter`.
export interface ChainAdapterInputs {
    chain?: ChainAdapter;
    /// Pre-built signer (EIP-1193 wrapper, private key signer, etc.).
    signer?: EthSigner;
    /// Browser-style entry: raw EIP-1193 provider + the signing account +
    /// chainId. SDK builds an `Eip1193Signer` internally.
    provider?: Eip1193ProviderLike;
    address?: `0x${string}`;
    /// 0x-hex private key for Node tests / CLI builds.
    privateKey?: `0x${string}`;
    rpcUrl?: string;
}

/// Build the default `ViemChainAdapter`. Used by `connect()` when the
/// caller passes `signer` / `provider` / `privateKey` rather than a
/// pre-built adapter.
export function defaultChainAdapter(
    inputs: ChainAdapterInputs,
    preset: DeployedNetworkPreset,
): ChainAdapter {
    if (inputs.chain) return inputs.chain;

    const errs: string[] = [];
    if (!inputs.rpcUrl) {
        errs.push("`rpcUrl` required when building chain adapter (or pass a pre-built `chain`)");
    }
    if (!inputs.signer && !(inputs.provider && inputs.address) && !inputs.privateKey) {
        errs.push("pass one of `chain`, `signer`, `{provider,address}`, or `privateKey`");
    }
    if (errs.length) throw new WalletConfigError(errs);

    const signer: EthSigner =
        inputs.signer ??
        (inputs.provider && inputs.address
            ? new Eip1193Signer(inputs.provider, inputs.address, preset.chainId)
            : new PrivateKeySigner(
                  inputs.privateKey as `0x${string}`,
                  inputs.rpcUrl as string,
                  preset.chainId,
              ));

    return new ViemChainAdapter({
        rpcUrl: inputs.rpcUrl as string,
        signer,
        maspAddress: preset.maspAddress,
        chainId: preset.chainId,
        permit2Address: preset.permit2Address,
    });
}

/// Inputs `connect()` collects to wire a default browser/node prover.
export interface ProverBuildInputs {
    prover?: Prover;
    proverArtifacts?: ProverArtifacts | ProverPaths;
    proverArtifactsCdn?: string;
    useWasmProver?: boolean;
}

/// Build the optional `Prover` for `connect()`. Returning `undefined`
/// defers to `Wallet.create` → `defaultProver` (snarkjs path with bundled
/// artifacts).
export async function buildConnectProver(
    inputs: ProverBuildInputs,
    runtime: "node" | "browser",
): Promise<Prover | undefined> {
    if (inputs.prover) return inputs.prover;

    // Defer to `Wallet.create` → `defaultProver` when on the snarkjs path
    // without artifacts; keeps fallback resolution in one place.
    const useWasm = inputs.useWasmProver ?? runtime === "node";
    if (!useWasm && !inputs.proverArtifacts) return undefined;

    const artifacts = inputs.proverArtifacts
        ? inputs.proverArtifacts
        : await bundledProverArtifacts({ runtime, cdn: inputs.proverArtifactsCdn });
    const paths = resolveArtifacts(artifacts);
    if (!useWasm) return new SnarkjsProver(paths);
    // Dynamic import keeps wasm-bindgen-rayon worker glue out of bundles
    // that opt out via `useWasmProver: false`.
    const { WasmProver } = await import("../prover/wasm-prover.js");
    return WasmProver.build(paths);
}
