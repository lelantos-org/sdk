// The 0.39 application type contract, asserted at compile time.
//
// Each `@ts-expect-error` is an assertion: if the rejected shape starts compiling, the directive is
// unused and the type check fails. The `_`-prefixed functions are never called.

import { expectTypeOf } from "vitest";
import type { ChainAdapter, ChainReader } from "../../chain/port.js";
import {
    type AssetId,
    type CircuitAmount,
    circuitAmount,
    type EvmAddress,
    type ShieldedAddress,
    type TokenAmount,
} from "../../core/brand.js";
import type { EthSigner } from "../../keys/signer.js";
import type { Prover } from "../../prover/types.js";
import type { ReadOnlyWalletApi, WalletApi } from "../api.js";
import type { Amount, OutAmount } from "../assets/amount.js";
import type {
    ConnectOptions,
    ConnectWatchOptions,
    NetworkPreset,
    ProverOption,
    ScannerOption,
} from "../connect/options.js";
import type {
    DepositOptions,
    DepositPhase,
    QuoteSwapOptions,
    SpendPhase,
    SwapOptions,
    TransferOptions,
    WithdrawOptions,
} from "./options.js";
import type { SwapQuote } from "./quotes.js";
import type { TransactionResult } from "./results.js";

declare const connect: (options: ConnectOptions) => Promise<WalletApi>;
declare const connectWatch: (options: ConnectWatchOptions) => Promise<ReadOnlyWalletApi>;
declare const units: CircuitAmount;
declare const base: TokenAmount;
declare const id: AssetId;
declare const shielded: ShieldedAddress;
declare const evm: EvmAddress;
declare const quote: SwapQuote;
declare const signer: EthSigner;
declare const reader: ChainReader;
declare const adapter: ChainAdapter;
declare const prover: Prover;

// --- amounts -------------------------------------------------------------------------------------

function _amountForms() {
    const a: Amount[] = ["1.5", units, circuitAmount(5n), { baseUnits: 5n }, { baseUnits: base }];
    const r: Amount = { baseUnits: 5n, round: "down" };
    return [a, r];
}

function _plainBigintIsNotAnAmount() {
    // @ts-expect-error — a bare bigint could be circuit or base units.
    const a: Amount = 5n;
    // @ts-expect-error — a number cannot hold a decimal exactly.
    const b: Amount = 5;
    // @ts-expect-error — base units must say so (`{ baseUnits }`), not arrive as a brand.
    const c: Amount = base;
    // @ts-expect-error — `round` is one of the three policies.
    const d: Amount = { baseUnits: 5n, round: "nearest" };
    return [a, b, c, d];
}

function _outAmountIsGrossXorNet() {
    const ok: OutAmount[] = [{ gross: "1" }, { net: units }];
    // @ts-expect-error — both sides at once.
    const both: OutAmount = { gross: "1", net: "1" };
    // @ts-expect-error — neither side.
    const neither: OutAmount = {};
    return [ok, both, neither];
}

// --- connect -------------------------------------------------------------------------------------

function _connectShapes() {
    void connect({ network: "anvil", privateKey: "0x01" });
    void connect({ network: "anvil", mnemonic: "m", account: 1, signer });
    void connect({ network: "base", rpcUrl: "https://rpc", nsk: 1n, readOnly: true });
    void connect({ network: "anvil", signature: "0x01", reader });
    void connect({ network: "anvil", mnemonic: "m", chain: adapter, prover: "none" });
    void connect({ network: "anvil", provider: { request: async () => null }, address: evm });
}

function _chainGroupIsExclusive() {
    // @ts-expect-error — two chain layers.
    void connect({ network: "anvil", privateKey: "0x01", signer });
    // @ts-expect-error — `readOnly` and a signer contradict each other.
    void connect({ network: "anvil", nsk: 1n, readOnly: true, reader });
    // @ts-expect-error — no chain layer at all.
    void connect({ network: "anvil", nsk: 1n });
}

function _keyGroupIsExclusive() {
    // @ts-expect-error — two key sources.
    void connect({ network: "anvil", mnemonic: "m", nsk: 1n, signer });
    // @ts-expect-error — `account` belongs to `mnemonic`.
    void connect({ network: "anvil", signature: "0x01", account: 1, signer });
    // @ts-expect-error — a read-only layer has nothing to derive a key from.
    void connect({ network: "anvil", readOnly: true });
    // @ts-expect-error — nor does a pre-built adapter, which does not expose its signer.
    void connect({ network: "anvil", chain: adapter });
}

function _networkNames() {
    // @ts-expect-error — a placeholder (undeployed) network does not compile.
    void connect({ network: "sepolia", privateKey: "0x01" });
    const placeholder = { chainId: 1n, maspAddress: null, relayerAddress: null };
    // @ts-expect-error — nor does a preset with no contracts.
    const p: NetworkPreset = { ...placeholder, relayerUrl: "", fmdUrl: "", treeDepth: 10 };
    return p;
}

function _pluggableOptions() {
    const provers: ProverOption[] = [prover, "none", { warmup: "eager", backend: "wasm" }];
    // @ts-expect-error — a submitter is an `./advanced` concern.
    void connect({ network: "anvil", privateKey: "0x01", submitter: {} });
    const scanners: ScannerOption[] = ["inline", { workers: () => ({}) as never, size: 4 }];
    return [provers, scanners];
}

async function _readOnlyConnectIsStillAWalletApi() {
    // Same interface: spends need no EOA, deposits report through `capabilities`.
    const w = await connect({ network: "anvil", nsk: 1n, readOnly: true });
    expectTypeOf(w).toEqualTypeOf<WalletApi>();
    expectTypeOf(w.capabilities.deposit).toEqualTypeOf<boolean>();
    const watch = await connectWatch({ network: "anvil", viewingKey: "lelantosivk1x" });
    expectTypeOf(watch).toEqualTypeOf<ReadOnlyWalletApi>();
    expectTypeOf<WalletApi>().toExtend<ReadOnlyWalletApi>();
    // @ts-expect-error — a watch wallet reports no capabilities; the spend surface is
    // `watch/capability.test-d.ts`.
    void watch.capabilities;
    expectTypeOf(w.keys.tier).toEqualTypeOf<"spending">();
}

// --- ops: asset required, recipient naming, phases -----------------------------------------------

function _assetIsRequiredEverywhere(w: WalletApi) {
    // @ts-expect-error — deposit without an asset.
    const d: DepositOptions = { amount: "1" };
    // @ts-expect-error — transfer without an asset.
    const t: TransferOptions = { amount: "1", recipient: shielded };
    // @ts-expect-error — withdraw without an asset.
    const wd: WithdrawOptions = { gross: "1", recipient: evm };
    // @ts-expect-error — quoteSwap without `assetIn`.
    const q: QuoteSwapOptions = { assetOut: id, gross: "1", slippageBps: 50 };
    // @ts-expect-error — balance names its asset.
    void w.balance();
    // @ts-expect-error — as does spendableMax.
    void w.spendableMax();
    // @ts-expect-error — and withdrawDenominations.
    void w.withdrawDenominations();
    return [d, t, wd, q];
}

function _recipientNaming() {
    const t: TransferOptions = { asset: "USDC", amount: "1", recipient: shielded };
    const wd: WithdrawOptions = { asset: "USDC", net: "1", recipient: evm, native: true };
    const s: SwapOptions = { quote, recipient: shielded, feeAsset: id };
    return [t, wd, s];
}

function _withdrawAndSwapNameASide() {
    // @ts-expect-error — withdraw needs gross or net.
    const w1: WithdrawOptions = { asset: "USDC", recipient: evm };
    // @ts-expect-error — not both.
    const w2: WithdrawOptions = { asset: "USDC", recipient: evm, gross: "1", net: "1" };
    // @ts-expect-error — a swap's amount comes from its quote.
    const s1: SwapOptions = { quote, gross: "1" };
    // @ts-expect-error — as do its assets.
    const s2: SwapOptions = { quote, assetIn: id };
    return [w1, w2, s1, s2];
}

function _phasesMatchTheOperation() {
    const t: TransferOptions = {
        asset: id,
        amount: units,
        recipient: shielded,
        onPhase: (phase, info) => {
            expectTypeOf(phase).toEqualTypeOf<SpendPhase>();
            expectTypeOf(info.opId).toEqualTypeOf<string>();
        },
    };
    const d: DepositOptions = {
        asset: id,
        amount: units,
        onPhase: (phase) => expectTypeOf(phase).toEqualTypeOf<DepositPhase>(),
    };
    expectTypeOf<"signing">().not.toExtend<SpendPhase>();
    expectTypeOf<"proving">().not.toExtend<DepositPhase>();
    return [t, d];
}

function _resultsDiscriminate(r: TransactionResult) {
    switch (r.kind) {
        case "withdraw":
            expectTypeOf(r.onLadder).toEqualTypeOf<boolean>();
            expectTypeOf(r.net.baseUnits).toEqualTypeOf<TokenAmount>();
            break;
        case "deposit":
            expectTypeOf(r.escrow.depositId).toEqualTypeOf<bigint>();
            break;
        case "swap":
            expectTypeOf(r.expectedCredit.amount).toEqualTypeOf<CircuitAmount>();
            break;
        case "transfer":
            expectTypeOf(r.recipientCommitment).not.toBeAny();
            break;
    }
}
