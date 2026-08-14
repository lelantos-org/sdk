// keccak(abi.encode(...)) hashes over the on-chain protocol structs.
//
// Both functions encode `AUX_OUTPUT_COMPONENTS`, so they belong together: a
// change to the struct layout has to move both or neither. `computePiHash` is
// the deposit-side binding (MASP.deposit); `auxDigest` is the spend-side
// one (PubInputs.compress).

import { encodeAbiParameters, keccak256 } from "viem";
import { branded, type Hex32 } from "../core/brand.js";
import { BN254_FR, type Field } from "../core/field.js";
import { bytesToHex } from "../core/hex.js";
import { AUX_OUTPUT_COMPONENTS, type AuxOutput, type DepositRequest } from "./deposit-request.js";

/**
 * Component list of `PubInputs.DepositRequest`, in declaration order.
 *
 * The Permit2 witness is `keccak256(abi.encode(d, aux))`, so every field, its
 * type and its position are consensus-binding: a mismatch produces a signature
 * the contract rejects. `abi-hash.test.ts` derives the same list from the
 * canonical ABI and asserts it matches, rather than trusting this transcription.
 *
 * @internal
 */
export const DEPOSIT_REQUEST_COMPONENTS = [
    { name: "chainId", type: "uint256" },
    { name: "publicAssetId", type: "uint64" },
    { name: "publicIn", type: "uint64" },
    { name: "payer", type: "address" },
    { name: "recipient", type: "address" },
    { name: "outCm", type: "bytes32" },
    { name: "cvDep", type: "uint256[2]" },
    { name: "rcv", type: "uint256" },
] as const;

/**
 * Compute `piHash = keccak256(abi.encode(DepositRequest, AuxValidation.Output))`.
 * Mirrors MASP.deposit line `keccak256(abi.encode(d, aux))`.
 */
export function computePiHash(deposit: DepositRequest, aux: AuxOutput): Hex32 {
    const encoded = encodeAbiParameters(
        [
            { type: "tuple", components: [...DEPOSIT_REQUEST_COMPONENTS] },
            { type: "tuple", components: [...AUX_OUTPUT_COMPONENTS] },
        ],
        [
            {
                chainId: deposit.chainId,
                publicAssetId: deposit.publicAssetId,
                publicIn: deposit.publicIn,
                payer: deposit.payer as `0x${string}`,
                recipient: deposit.recipient as `0x${string}`,
                outCm: deposit.outCm as `0x${string}`,
                cvDep: deposit.cvDep,
                rcv: deposit.rcv,
            },
            {
                clueRx: aux.clueRx,
                clueRy: aux.clueRy,
                ephPubX: aux.ephPubX,
                ephPubY: aux.ephPubY,
                ciphertext: bytesToHex(aux.ciphertext) as `0x${string}`,
            },
        ] as never,
    );
    return branded<Hex32>(keccak256(encoded));
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
