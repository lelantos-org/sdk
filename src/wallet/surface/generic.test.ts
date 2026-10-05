import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../../errors/config.js";
import type { WalletApi } from "../api.js";
import { genericCall } from "./generic.js";

describe("genericCall", () => {
    it("refuses an object no SDK constructor built", async () => {
        await expect(
            genericCall({} as WalletApi, {
                asset: 1n,
                amount: { net: { baseUnits: 1n } },
                calls: [],
                minGas: 1n,
            }),
        ).rejects.toBeInstanceOf(InvalidArgumentError);
    });
});
