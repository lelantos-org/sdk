// `NETWORKS` asserts its address literals as `EvmAddress` rather than running
// them through `evmAddress()`, so the table stays a pure declaration. These
// tests verify that assertion.

import { describe, expect, it } from "vitest";
import { evmAddress } from "../core/brand.js";
import { isWalletError } from "../errors/guard.js";
import {
    type DeployedNetworkName,
    isNetworkDeployed,
    NETWORKS,
    type NetworkName,
    type NetworkPreset,
    type PlaceholderNetworkPreset,
    resolveNetwork,
} from "./networks.js";

const names = Object.keys(NETWORKS) as NetworkName[];

describe("NETWORKS", () => {
    it.each(names)("%s declares well-formed addresses", (name) => {
        const p: NetworkPreset | PlaceholderNetworkPreset = NETWORKS[name];
        for (const addr of [
            p.maspAddress,
            p.relayerAddress,
            p.permit2Address,
            p.nativeAdapterAddress,
            p.swapWrapperAddress,
        ]) {
            if (addr !== null && addr !== undefined) {
                expect(() => evmAddress(addr)).not.toThrow();
            }
        }
    });

    it.each(names)("%s declares parseable service URLs", (name) => {
        const p: NetworkPreset | PlaceholderNetworkPreset = NETWORKS[name];
        for (const url of [p.relayerUrl, p.fmdUrl, p.quoterUrl, p.rpcUrl]) {
            if (url !== undefined) expect(() => new URL(url)).not.toThrow();
        }
    });

    it("marks a preset deployed exactly when both addresses are present", () => {
        for (const name of names) {
            const p = NETWORKS[name];
            expect(isNetworkDeployed(p)).toBe(p.maspAddress !== null && p.relayerAddress !== null);
        }
    });
});

describe("DeployedNetworkName", () => {
    // The type is derived from the `maspAddress: null` literals. This pins the
    // runtime side: every name the type admits resolves to a deployed preset.
    const deployed: DeployedNetworkName[] = ["anvil", "base", "arbitrum", "mainnet"];

    it.each(deployed)("%s resolves to a deployed preset", (name) => {
        expect(isNetworkDeployed(resolveNetwork(name))).toBe(true);
    });

    it("excludes the placeholders", () => {
        for (const name of names) {
            if (deployed.includes(name as DeployedNetworkName)) continue;
            expect(isNetworkDeployed(NETWORKS[name])).toBe(false);
        }
    });
});

describe("anvil", () => {
    // `backend/stack`: relayer on 3003, fmd-webserver on 3001, tree depth 11.
    it("points at the backend stack's ports and ships an RPC endpoint", () => {
        expect(NETWORKS.anvil).toMatchObject({
            relayerUrl: "http://localhost:3003",
            fmdUrl: "http://localhost:3001",
            rpcUrl: "http://localhost:8545",
            treeDepth: 11,
        });
    });

    it("public networks ship no RPC endpoint", () => {
        for (const name of names) {
            if (name === "anvil") continue;
            expect((NETWORKS[name] as { rpcUrl?: string }).rpcUrl).toBeUndefined();
        }
    });
});

describe("resolveNetwork", () => {
    it("passes a custom preset through untouched", () => {
        const custom = NETWORKS.anvil;
        expect(resolveNetwork(custom)).toBe(custom);
    });

    it("throws on an unknown name", () => {
        expect(() => resolveNetwork("nope" as NetworkName)).toThrow(/unknown network/);
    });

    // A preset name comes from application config, so an unknown one is a
    // caller wiring error, which `WalletConfigError` covers and `isWalletError`
    // recognises.
    it("reports an unknown name as a typed config error", () => {
        let thrown: unknown;
        try {
            resolveNetwork("nope" as NetworkName);
        } catch (err) {
            thrown = err;
        }
        expect(isWalletError(thrown, "WALLET_CONFIG")).toBe(true);
    });
});
