// Calldata of a handle registration, and the event that marks one. Loaded with the operation.
//
// The two function fragments are spelled here, not taken from `./abi.ts`: that table is shared
// with the eagerly loaded chain reader, and importing it from a lazily loaded module keeps every
// ABI in it alive in the entry's chunks. `names.test.ts` decodes what these encode with the shared
// table.

import { encodeFunctionData, keccak256, pad, stringToBytes } from "viem";
import type { Hex32 } from "../../core/brand.js";
import type { TxLog } from "../types.js";

const REGISTER_ABI = [
    {
        type: "function",
        name: "register",
        stateMutability: "nonpayable",
        inputs: [
            { name: "label", type: "string" },
            { name: "value", type: "string" },
            { name: "controller", type: "address" },
        ],
        outputs: [],
    },
] as const;

const APPROVE_ABI = [
    {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
    },
] as const;

/** `keccak256("HandleRegistered(bytes32,address,string)")`. */
export const HANDLE_REGISTERED_TOPIC =
    "0xb51e24ca9479f1f48c99c45f4d89c5a1853cfab00d1852d28bb3ea9f1feb58c6" as Hex32;

const asAddress = (a: string) => a as `0x${string}`;

/** Calldata of `register(label, value, controller)`. */
export function encodeRegisterName(label: string, value: string, controller: string): string {
    return encodeFunctionData({
        abi: REGISTER_ABI,
        functionName: "register",
        args: [label, value, asAddress(controller)],
    });
}

/** Calldata of the fee token's `approve(spender, amount)`. */
export function encodeApprove(spender: string, amount: bigint): string {
    return encodeFunctionData({
        abi: APPROVE_ABI,
        functionName: "approve",
        args: [asAddress(spender), amount],
    });
}

/**
 * Whether `logs`, one transaction's receipt, hold the registrar's `HandleRegistered` for `label`
 * and `controller`: the registration in that transaction landed.
 */
export function handleRegisteredIn(
    logs: readonly TxLog[],
    registration: { registrar: string; label: string; controller: string },
): boolean {
    const registrar = registration.registrar.toLowerCase();
    const labelHash = keccak256(stringToBytes(registration.label));
    const controller = pad(asAddress(registration.controller)).toLowerCase();
    return logs.some(
        (l) =>
            l.address.toLowerCase() === registrar &&
            l.topics[0]?.toLowerCase() === HANDLE_REGISTERED_TOPIC &&
            l.topics[1]?.toLowerCase() === labelHash &&
            l.topics[2]?.toLowerCase() === controller,
    );
}
