// `LelantosNameRegistrar` reads over viem.
//
// The functions take any client with `readContract`, so a caller with no wallet (a public profile
// page) uses them with its own `PublicClient`. The calldata of a registration is in
// `./name-calls.ts`, which only the operation loads.

import { type PublicClient, zeroAddress } from "viem";
import { branded, type EvmAddress, type TokenAmount } from "../../core/brand.js";
import type { NameFee, NameRecord } from "../types.js";
import { NAME_REGISTRAR_ABI } from "./abi.js";

type ReadClient = Pick<PublicClient, "readContract">;

const asAddress = (a: string) => a as `0x${string}`;

/**
 * The record of `label`. The value is returned as stored: the registrar never parses it, so decode
 * it (`decodeAddress`) before paying it.
 */
export async function readNameRecord(
    client: ReadClient,
    registrar: string,
    label: string,
): Promise<NameRecord> {
    const [value, controller, nonce] = await client.readContract({
        address: asAddress(registrar),
        abi: NAME_REGISTRAR_ABI,
        functionName: "recordOf",
        args: [label],
    });
    return {
        registered: controller !== zeroAddress,
        value,
        controller: branded<EvmAddress>(controller),
        nonce,
    };
}

/** Whether `label` is valid and unregistered. */
export function readNameAvailable(
    client: ReadClient,
    registrar: string,
    label: string,
): Promise<boolean> {
    return client.readContract({
        address: asAddress(registrar),
        abi: NAME_REGISTRAR_ABI,
        functionName: "available",
        args: [label],
    });
}

/** What `register` charges its caller. */
export async function readNameFee(client: ReadClient, registrar: string): Promise<NameFee> {
    const address = asAddress(registrar);
    const [token, amount] = await Promise.all([
        client.readContract({ address, abi: NAME_REGISTRAR_ABI, functionName: "feeToken" }),
        client.readContract({ address, abi: NAME_REGISTRAR_ABI, functionName: "feeAmount" }),
    ]);
    return { token: branded<EvmAddress>(token), amount: branded<TokenAmount>(amount) };
}
