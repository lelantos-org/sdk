// `NETWORKS` asserts its address literals as `EvmAddress` rather than running
// them through `evmAddress()`, so the table stays a pure declaration. These
// tests are what make that assertion true.

import { describe, expect, it } from "vitest";
import { evmAddress } from "../core/brand.js";
import {
    type DeployedNetworkName,
    isNetworkDeployed,
    NETWORKS,
    type NetworkName,
    type NetworkPreset,
    resolveNetwork,
} from "./networks.js";

const names = Object.keys(NETWORKS) as NetworkName[];

describe("NETWORKS", () => {
    it.each(names)("%s declares well-formed addresses", (name) => {
        const p: NetworkPreset = NETWORKS[name];
        for (const addr of [p.maspAddress, p.relayerAddress, p.permit2Address]) {
            if (addr !== null && addr !== undefined) {
                expect(() => evmAddress(addr)).not.toThrow();
            }
        }
    });

    it.each(names)("%s declares parseable service URLs", (name) => {
        const p: NetworkPreset = NETWORKS[name];
        expect(() => new URL(p.relayerUrl)).not.toThrow();
        expect(() => new URL(p.fmdUrl)).not.toThrow();
    });

    it("marks a preset deployed exactly when both addresses are present", () => {
        for (const name of names) {
            const p = NETWORKS[name];
            expect(isNetworkDeployed(p)).toBe(p.maspAddress !== null && p.relayerAddress !== null);
        }
    });
});

describe("DeployedNetworkName", () => {
    // The type is derived from the `maspAddress: null` literals, so it tracks
    // the table automatically. This pins the runtime side of that agreement:
    // every name the type admits resolves to a deployed preset.
    const deployed: DeployedNetworkName[] = ["anvil", "localnet"];

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

describe("resolveNetwork", () => {
    it("passes a custom preset through untouched", () => {
        const custom = NETWORKS.anvil;
        expect(resolveNetwork(custom)).toBe(custom);
    });

    it("throws on an unknown name", () => {
        expect(() => resolveNetwork("nope" as NetworkName)).toThrow(/unknown network/);
    });
});
