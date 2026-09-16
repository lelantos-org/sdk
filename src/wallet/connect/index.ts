// `connect()`, the high-level entrypoint. For full control over every pluggable, use
// `createWallet(KeySource, WalletConfig)`.
//
// Order: validate the whole config → resolve the preset → build the chain layer →
// the prover handle (no I/O) → wasm and the scanner → stores and notes → derive the key last, the
// only step that may prompt → on any failure dispose everything `connect` built (never a
// caller-supplied prover or scanner).

import type { NetworkPreset } from "../../chain/networks.js";
import { settleAll } from "../../core/async.js";
import { Poseidon } from "../../crypto/index.js";
import { Jubjub } from "../../crypto/jubjub-wasm/index.js";
import { boundary } from "../../errors/boundary.js";
import { NetworkNotDeployedError, WalletConfigError } from "../../errors/config.js";
import { getLogger } from "../../log/logger.js";
import { detectRuntime } from "../../runtime/detect.js";
import type { WalletApi } from "../api.js";
import { MAX_TREE_DEPTH } from "../constants.js";
import { assembleWallet } from "../create.js";
import { defaultChainAdapter } from "../defaults/chain.js";
import { httpOptionProblems } from "../defaults/http.js";
import { buildProverHandle, type ProverHandle, proverOptionProblems } from "../defaults/prover.js";
import { type BuiltScanner, buildScanner, scannerOptionProblems } from "../defaults/scanner.js";
import { configureWalletWasm } from "../defaults/wasm.js";
import type { WalletConfig } from "../types/config.js";
import { type ConnectOptionsLoose, explicitKeySources, keyThunk } from "./key-source.js";
import type { ConnectOptions, ProverOption, ScannerOption } from "./options.js";
import { namedPreset } from "./preset.js";

const log = getLogger("lelantos:wallet:connect");

const CHAIN_KEYS = ["chain", "reader", "readOnly", "signer", "provider", "privateKey"] as const;

/**
 * Connect a spending wallet.
 *
 * ```ts
 * const wallet = await connect({
 *     network: "base",
 *     rpcUrl: "https://base-rpc.example",
 *     privateKey: "0x…",
 * });
 * await wallet.sync();
 * const usdc = await wallet.asset("USDC");
 * const { total } = await wallet.balance(usdc.id);
 * await wallet.dispose();
 * ```
 *
 * Nothing is fetched for proving until the first spend or `warmProver()`. A `signer` or `provider`
 * without an explicit key source is asked for one EIP-712 signature, after every other step has
 * succeeded.
 *
 * On failure, `connect` disposes what it built (a worker-pool scanner, a `ProverConfig` prover)
 * and leaves a caller-supplied `Prover` / `Scanner` running; `wallet.dispose()` follows the same
 * rule. See {@link ProverOption} and {@link ScannerOption}.
 */
export function connect(options: ConnectOptions): Promise<WalletApi> {
    return boundary("connect", () => connectUnchecked(options));
}

/** The validated shape `connect` builds from. */
interface ConnectPlan {
    preset: NetworkPreset;
    rpcUrl: string | undefined;
    runtime: "node" | "browser";
}

/** Every configuration problem at once, before anything is built or fetched. */
function validateConnect(opts: ConnectOptionsLoose): ConnectPlan {
    if (typeof opts !== "object" || opts === null) {
        throw new WalletConfigError("`connect` takes an options object");
    }
    const preset = resolvePreset(opts.network);
    const missing: string[] = [];

    const chainGroups = CHAIN_KEYS.filter((k) => opts[k] !== undefined && opts[k] !== false);
    if (opts.address !== undefined && opts.provider === undefined) {
        missing.push("`address` belongs with `provider`");
    }
    if (opts.provider !== undefined && opts.address === undefined) {
        missing.push("`provider` needs the `address` to sign as");
    }
    if (chainGroups.length === 0) {
        missing.push(
            "a chain layer: one of `chain`, `reader`, `readOnly: true`, `signer`, " +
                "`{ provider, address }` or `privateKey`",
        );
    } else if (chainGroups.length > 1) {
        missing.push(`one chain layer, not ${chainGroups.map((k) => `\`${k}\``).join(" and ")}`);
    }
    if (opts.readOnly !== undefined && opts.readOnly !== true) {
        missing.push("`readOnly` (only `true`)");
    }

    const keySources = explicitKeySources(opts);
    if (keySources.length > 1) {
        missing.push(`one key source, not ${keySources.map((k) => `\`${k}\``).join(" and ")}`);
    }
    if (
        (opts.account !== undefined || opts.passphrase !== undefined) &&
        opts.mnemonic === undefined
    ) {
        missing.push("`account` / `passphrase` belong with `mnemonic`");
    }
    const selfKeying =
        opts.signer !== undefined || opts.provider !== undefined || !!opts.privateKey;
    if (keySources.length === 0 && chainGroups.length === 1 && !selfKeying) {
        missing.push(
            "a key source (`mnemonic`, `signature` or `nsk`): a `chain`, `reader` or `readOnly` " +
                "layer holds no key to derive one from",
        );
    }

    const rpcUrl = opts.rpcUrl ?? preset.rpcUrl;
    const prebuilt = opts.chain !== undefined || opts.reader !== undefined;
    if (!prebuilt && !rpcUrl) {
        missing.push(
            "`rpcUrl` (in the options or on the preset); public presets ship none — pass your " +
                "own endpoint",
        );
    }
    if (rpcUrl !== undefined && !isUrl(rpcUrl)) missing.push("`rpcUrl` (an http(s) URL)");

    missing.push(...proverOptionProblems(opts.prover));
    missing.push(...scannerOptionProblems(opts.scanner));
    missing.push(...httpOptionProblems(opts.http));
    if (opts.storage !== undefined && (typeof opts.storage !== "object" || opts.storage === null)) {
        missing.push("`storage` (`{ notes?, tree?, nullifiers? }`)");
    }
    if (
        opts.runtime !== undefined &&
        opts.runtime !== "auto" &&
        opts.runtime !== "node" &&
        opts.runtime !== "browser"
    ) {
        missing.push('`runtime` ("node", "browser" or "auto")');
    }
    if (missing.length) throw new WalletConfigError(missing);

    return {
        preset,
        rpcUrl,
        runtime:
            opts.runtime === undefined || opts.runtime === "auto" ? detectRuntime() : opts.runtime,
    };
}

function isUrl(s: string): boolean {
    try {
        const u = new URL(s);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch {
        return false;
    }
}

/** A preset name or object → a deployed preset, or the error that says why not. */
function resolvePreset(network: unknown): NetworkPreset {
    const named = namedPreset(network);
    if (named) return named;
    const p = network as Partial<NetworkPreset> & {
        maspAddress?: unknown;
        relayerAddress?: unknown;
    };
    if (p.maspAddress === null || p.relayerAddress === null) {
        throw new NetworkNotDeployedError("<custom>");
    }
    const missing: string[] = [];
    if (typeof p.chainId !== "bigint") missing.push("`network.chainId` (a bigint)");
    if (typeof p.maspAddress !== "string") missing.push("`network.maspAddress`");
    if (typeof p.relayerAddress !== "string") missing.push("`network.relayerAddress`");
    if (typeof p.relayerUrl !== "string") missing.push("`network.relayerUrl`");
    if (typeof p.fmdUrl !== "string") missing.push("`network.fmdUrl`");
    if (
        typeof p.treeDepth !== "number" ||
        !Number.isInteger(p.treeDepth) ||
        p.treeDepth <= 0 ||
        p.treeDepth > MAX_TREE_DEPTH
    ) {
        missing.push(`\`network.treeDepth\` (integer in 1..${MAX_TREE_DEPTH})`);
    }
    if (missing.length) throw new WalletConfigError(missing);
    return p as NetworkPreset;
}

async function connectUnchecked(options: ConnectOptions): Promise<WalletApi> {
    const opts = options as ConnectOptionsLoose;
    const plan = validateConnect(opts);
    const { preset, rpcUrl, runtime } = plan;
    if (opts.wasm) await configureWalletWasm(opts.wasm);

    // Only what `connect` built is disposed on failure; a caller-supplied `Prover` / `Scanner`
    // stays with the caller (`owned: false`).
    let prover: ProverHandle | undefined;
    let scanner: BuiltScanner | undefined;
    try {
        const chain = await defaultChainAdapter(
            {
                chain: opts.chain,
                reader: opts.reader,
                readOnly: opts.readOnly,
                signer: opts.signer,
                provider: opts.provider,
                address: opts.address,
                privateKey: opts.privateKey,
                rpcUrl,
                fetch: opts.http?.fetch,
            },
            preset,
        );

        prover = buildProverHandle(opts.prover, { runtime, shape: opts.shape });

        const P = await Poseidon.build();
        const J = await Jubjub.build();
        scanner = await buildScanner(opts.scanner, { P, J });

        const cfg: WalletConfig = {
            chainId: preset.chainId,
            treeDepth: preset.treeDepth,
            relayerAddress: preset.relayerAddress,
            chain,
            fmdUrl: preset.fmdUrl,
            relayerUrl: preset.relayerUrl,
            ...(preset.quoterUrl ? { quoterUrl: preset.quoterUrl } : {}),
            ...(preset.swapWrapperAddress ? { swapWrapperAddress: preset.swapWrapperAddress } : {}),
            ...(preset.submitTimeoutMs !== undefined
                ? { submitTimeoutMs: preset.submitTimeoutMs }
                : {}),
            ...(opts.http ? { http: opts.http } : {}),
            ...(opts.shape ? { shape: opts.shape } : {}),
            ...(opts.storage?.notes ? { noteStore: opts.storage.notes } : {}),
            ...(opts.storage?.tree ? { treePersistence: opts.storage.tree } : {}),
            ...(opts.storage?.nullifiers ? { nullifierPersistence: opts.storage.nullifiers } : {}),
            ...(opts.denominations !== undefined ? { denominations: opts.denominations } : {}),
            ...(opts.syncStrategy ? { syncStrategy: opts.syncStrategy } : {}),
            scanner: scanner.scanner,
        };

        // `assembleWallet` owns disposal from here: it releases what the SDK built itself.
        const built = { prover, scanner };
        prover = undefined;
        scanner = undefined;
        return await assembleWallet(keyThunk(opts, preset.chainId), cfg, {
            P,
            J,
            prover: built.prover,
            scannerOwned: built.scanner.owned,
        });
    } catch (err) {
        await settleAll(
            [
                scanner?.owned ? scanner.scanner.dispose?.() : undefined,
                prover?.owned ? prover.prover.dispose?.() : undefined,
            ],
            (err) => log.warn("dispose after a failed connect failed", { err }),
        );
        throw err;
    }
}
