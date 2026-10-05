// A wallet on the local stack (`backend/stack`, `just up`), for the scripts in this directory.
//
// The network preset is assembled from what the stack publishes: the registry's `/v1/chains` and
// the relayer's `/chains`. The SDK's built-in `anvil` preset is not used, because every address on
// the stack is minted by its deploy step.
//
// Run `npm run build` first: the scripts import `dist/`.

import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { connect } from "../../dist/entry/index.js";

const env = (name, fallback) => process.env[name] ?? fallback;

export const STACK = {
    chainId: BigInt(env("CHAIN_ID", "31337")),
    rpcUrl: env("RPC_URL", "http://localhost:8545"),
    registryUrl: env("REGISTRY_URL", "http://localhost:3005"),
    relayerUrl: env("RELAYER_URL", "http://localhost:3003"),
    fmdUrl: env("FMD_URL", "http://localhost:3001"),
    // anvil's second default account: funded with native coin, unused by the deploy.
    payerKey: env(
        "PAYER_KEY",
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    ),
};

const MOCK_ERC20 = parseAbi([
    "function mint(address to, uint256 amount)",
    "function approve(address spender, uint256 amount) returns (bool)",
]);

async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
}

/** This chain's entries in the registry and the relayer, and the preset built from them. */
export async function stackNetwork() {
    const pick = (body, where) => {
        const entry = body.chains.find((c) => BigInt(c.chainId) === STACK.chainId);
        if (!entry) throw new Error(`${where} lists no chain ${STACK.chainId}`);
        return entry;
    };
    const registry = pick(await getJson(`${STACK.registryUrl}/v1/chains`), "the registry");
    const relayer = pick(await getJson(`${STACK.relayerUrl}/chains`), "the relayer");
    const network = {
        chainId: STACK.chainId,
        maspAddress: registry.maspAddress,
        // The relayer's Bundler: the pool's caller, and the only account the wrappers let submit.
        relayerAddress: relayer.relayerAddress,
        relayerUrl: STACK.relayerUrl,
        fmdUrl: STACK.fmdUrl,
        rpcUrl: STACK.rpcUrl,
        treeDepth: registry.treeDepth,
        permit2Address: registry.permit2Address,
        ...(registry.nativeAdapterAddress
            ? { nativeAdapterAddress: registry.nativeAdapterAddress }
            : {}),
        // The wrappers and the registrar are deployment addresses, published by the registry.
        ...(registry.swapWrapperAddress ? { swapWrapperAddress: registry.swapWrapperAddress } : {}),
        ...(registry.genericCallWrapperAddress
            ? { genericCallWrapperAddress: registry.genericCallWrapperAddress }
            : {}),
        ...(registry.nameRegistrarAddress
            ? { nameRegistrarAddress: registry.nameRegistrarAddress }
            : {}),
    };
    return { network, registry, relayer };
}

/** A spending wallet over `nsk`, whose deposits are paid by `STACK.payerKey`. */
export async function stackWallet(nsk) {
    const { network, registry, relayer } = await stackNetwork();
    const wallet = await connect({ network, nsk, privateKey: STACK.payerKey });
    return { wallet, network, registry, relayer };
}

/**
 * Mint `amount` base units of a stack mock token to the payer, and let `permit2` pull it: a
 * deposit is a Permit2 transfer from the payer.
 */
export async function mintToPayer(token, amount, permit2) {
    const account = privateKeyToAccount(STACK.payerKey);
    const transport = http(STACK.rpcUrl);
    const publicClient = createPublicClient({ transport });
    const walletClient = createWalletClient({ account, transport });
    const hash = await walletClient.writeContract({
        address: token,
        abi: MOCK_ERC20,
        functionName: "mint",
        args: [account.address, amount],
        chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    const approval = await walletClient.writeContract({
        address: token,
        abi: MOCK_ERC20,
        functionName: "approve",
        args: [permit2, 2n ** 256n - 1n],
        chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: approval });
    return account.address;
}

/**
 * Shield `units` circuit units of pool asset `assetId` into `wallet`, minted to the payer first,
 * and wait out the flush and the one-block spend cooldown.
 */
export async function fundShielded(wallet, registry, assetId, units) {
    const asset = await wallet.asset(assetId);
    await mintToPayer(asset.token, units * asset.scale * 2n, registry.permit2Address);
    const deposit = await wallet.deposit({ asset: asset.id, amount: units });
    const flushed = await wallet.awaitDeposit(deposit.escrow, { timeoutMs: 180_000 });
    if (flushed.status !== "seen") throw new Error(`deposit not flushed: ${flushed.status}`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await wallet.sync();
    return asset;
}

/** The registry's plain (not yield-bearing) pool asset of `token` on this chain, or `undefined`. */
export async function plainAssetOf(token) {
    const assets = await getJson(`${STACK.registryUrl}/v1/assets`);
    return assets.find(
        (a) =>
            BigInt(a.chainId) === STACK.chainId &&
            a.token.toLowerCase() === token.toLowerCase() &&
            a.yieldState === undefined,
    );
}

export const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
