// `fmdUrl` is optional when the pluggables it would build are supplied.
//
// `validateConfig` accepts `noteSource` in place of `fmdUrl`, so the client is
// built only when a default needs one.

import { describe, expect, it } from "vitest";
import type { ChainAdapter } from "../../chain/port.js";
import { Jubjub, Poseidon } from "../../crypto/index.js";
import { WalletConfigError } from "../../errors/config.js";
import type { WalletConfig } from "../types/config.js";
import { resolveConfig } from "./index.js";

const base = async () => ({ P: await Poseidon.build(), J: await Jubjub.build() });

/** Every fmd-backed pluggable supplied, so no client is needed. */
const noFmdNeeded: WalletConfig = {
    chainId: 31337n,
    treeDepth: 10,
    relayerAddress: `0x${"11".repeat(20)}`,
    chain: {} as ChainAdapter,
    noteSource: { listNotes: async () => ({ inputs: [], nextAfter: 0, resumeAfter: 0 }) },
    treeStore: {} as never,
    nullifierStore: {} as never,
    submitter: {} as never,
    prover: {} as never,
};

describe("resolveConfig without fmdUrl", () => {
    it("resolves when every fmd-backed pluggable is supplied", async () => {
        const resolved = await resolveConfig(noFmdNeeded, await base());
        expect(resolved.noteSource).toBe(noFmdNeeded.noteSource);
    });

    it("reports the missing fmdUrl by name when a default does need one", async () => {
        const { treeStore: _t, ...needsFmd } = noFmdNeeded;
        await expect(resolveConfig(needsFmd as WalletConfig, await base())).rejects.toThrow(
            WalletConfigError,
        );
        await expect(resolveConfig(needsFmd as WalletConfig, await base())).rejects.toThrow(
            /fmdUrl/,
        );
    });
});
