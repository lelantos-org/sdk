import { describe, expect, it } from "vitest";
import { Jubjub } from "../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../crypto/poseidon.js";
import { decodeAddress } from "../keys/address.js";
import { deriveOutgoingKey } from "../notes/outgoing.js";
import { freshAccount } from "../test-utils/outputs.js";
import { createWalletContext } from "./context.js";
import type { NoteCache } from "./notes/note-cache.js";
import type { ResolvedWalletConfig } from "./types/config.js";

describe("createWalletContext", () => {
    it("carries the decoded default address and the outgoing key of its spending key", async () => {
        const P = await Poseidon.build();
        const J = await Jubjub.build();
        const { keys, address } = freshAccount(P, J);

        const ctx = createWalletContext({
            P,
            J,
            keys,
            address,
            cfg: { chainId: 31337n, submitter: {} } as unknown as ResolvedWalletConfig,
            notes: {} as NoteCache,
            autoConsolidate: async () => undefined,
        });

        expect(ctx.ownAddress).toEqual(decodeAddress(J, address));
        expect(ctx.outgoingKey).toEqual(deriveOutgoingKey(keys.nsk));
    });
});
