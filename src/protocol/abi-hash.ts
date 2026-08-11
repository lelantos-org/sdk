// keccak(abi.encode(...)) hashes over the on-chain protocol structs.
//
// Both functions encode `AUX_OUTPUT_COMPONENTS`, so they belong together: a
// change to the struct layout has to move both or neither. `computePiHash` is
// the deposit-side binding (MASP.submitIntent); `auxDigest` is the spend-side
// one (PubInputs.compress).

import { encodeAbiParameters, keccak256 } from "viem";
import { BN254_FR, type Field } from "../core/field.js";
import { bytesToHex } from "../core/hex.js";
import { AUX_OUTPUT_COMPONENTS, type AuxOutput, type DepositIntent } from "./deposit-intent.js";

/**
 * Compute `piHash = keccak256(abi.encode(DepositIntent, AuxValidation.Output[2]))`.
 * Mirrors MASP.submitIntent line `keccak256(abi.encode(d, aux))`.
 */
export function computePiHash(intent: DepositIntent, aux: [AuxOutput, AuxOutput]): string {
    const encoded = encodeAbiParameters(
        [
            {
                type: "tuple",
                components: [
                    { name: "chainId", type: "uint64" },
                    { name: "publicAssetId", type: "uint64" },
                    { name: "publicIn", type: "uint64" },
                    { name: "payer", type: "address" },
                    { name: "recipient", type: "address" },
                    { name: "outCm", type: "bytes32[2]" },
                    { name: "cvDep0", type: "uint256[2]" },
                    { name: "cvDep1", type: "uint256[2]" },
                    { name: "rcvTotal", type: "uint256" },
                    { name: "rcvDepPad", type: "uint256" },
                ],
            },
            {
                type: "tuple[2]",
                components: [...AUX_OUTPUT_COMPONENTS],
            },
        ],
        [
            {
                chainId: intent.chainId,
                publicAssetId: intent.publicAssetId,
                publicIn: intent.publicIn,
                payer: intent.payer as `0x${string}`,
                recipient: intent.recipient as `0x${string}`,
                outCm: intent.outCm as [`0x${string}`, `0x${string}`],
                cvDep0: intent.cvDep0,
                cvDep1: intent.cvDep1,
                rcvTotal: intent.rcvTotal,
                rcvDepPad: intent.rcvDepPad,
            },
            aux.map((a) => ({
                clueRx: a.clueRx,
                clueRy: a.clueRy,
                ephPubX: a.ephPubX,
                ephPubY: a.ephPubY,
                ciphertext: bytesToHex(a.ciphertext) as `0x${string}`,
            })) as never,
        ],
    );
    return keccak256(encoded);
}

/**
 * Binds the encrypted-note payload the relayer carries in calldata:
 * `keccak256(abi.encode(aux)) mod r` over the whole `AuxValidation.Output`
 * array. Mirrors `PubInputs.sol`, which MUST recompute this from the aux
 * calldata rather than accept it as an input.
 *
 * The clue fields are bound per output; this digest covers `ephPub` and
 * `ciphertext` as well. Without it a relayer could leave the clue intact — the
 * proof still verifies and the recipient's FMD scan still flags the note —
 * while corrupting the payload, leaving the recipient unable to derive the
 * ECDH secret or open a note whose inputs are already spent.
 *
 * Encoded as a dynamic `tuple[]`, so the length is part of the preimage and
 * arrays of different arity cannot collide.
 */
export function auxDigest(aux: readonly AuxOutput[]): Field {
    const encoded = encodeAbiParameters(
        [{ type: "tuple[]", components: [...AUX_OUTPUT_COMPONENTS] }],
        [
            aux.map((a) => ({
                clueRx: a.clueRx,
                clueRy: a.clueRy,
                ephPubX: a.ephPubX,
                ephPubY: a.ephPubY,
                ciphertext: bytesToHex(a.ciphertext) as `0x${string}`,
            })) as never,
        ],
    );
    return BigInt(keccak256(encoded)) % BN254_FR;
}
