// keccak(abi.encode(...)) hashes over the on-chain protocol structs. Every
// function here encodes `AUX_OUTPUT_COMPONENTS`, so a change to that struct's
// layout changes all of them.

import { encodeAbiParameters, keccak256 } from "viem";
import { branded, type Hex32 } from "../core/brand.js";
import { BN254_FR, type Field } from "../core/field.js";
import { auxOutputToWire } from "./aux-wire.js";
import {
    AUX_OUTPUT_COMPONENTS,
    type AuxOutput,
    abiAddress,
    auxTuple,
    type DepositRequest,
    depositTuple,
} from "./deposit-request.js";
import type { SwapBlob } from "./transact.js";

/**
 * Component list of `PubInputs.DepositRequest`, in declaration order.
 *
 * The Permit2 witness is `keccak256(abi.encode(d, aux, feeAux))`, so each
 * field's type and position are consensus-binding: a mismatch produces a
 * signature the contract rejects. `abi-hash.test.ts` checks the list against
 * the canonical ABI.
 *
 * @internal
 */
export const DEPOSIT_REQUEST_COMPONENTS = [
    { name: "chainId", type: "uint256" },
    { name: "publicAssetId", type: "uint64" },
    { name: "publicIn", type: "uint64" },
    { name: "payer", type: "address" },
    { name: "recipient", type: "address" },
    { name: "inner", type: "bytes32" },
    { name: "feeAssetId", type: "uint64" },
    { name: "feeIn", type: "uint64" },
    { name: "feeInner", type: "bytes32" },
] as const;

/**
 * `piHash = keccak256(abi.encode(DepositRequest, aux, feeAux))`, as
 * `MASP.deposit` computes it.
 *
 * `feeAux` is the encrypted payload of the note paying the relayer. The payer's
 * Permit2 witness covers both leaves a deposit mints, so neither can be
 * replaced after signing.
 */
export function computePiHash(deposit: DepositRequest, aux: AuxOutput, feeAux: AuxOutput): Hex32 {
    const encoded = encodeAbiParameters(
        DEPOSIT_WITH_AUX_PARAMS,
        depositWithAux(deposit, aux, feeAux) as never,
    );
    return branded<Hex32>(keccak256(encoded));
}

/**
 * `(DepositRequest, AuxValidation.Output, AuxValidation.Output)`: a deposit and
 * the payloads of the two leaves it mints, as `MASP.deposit` and
 * `SwapWrapper._intentHash` both encode them.
 */
const DEPOSIT_WITH_AUX_PARAMS = [
    { type: "tuple", components: [...DEPOSIT_REQUEST_COMPONENTS] },
    { type: "tuple", components: [...AUX_OUTPUT_COMPONENTS] },
    { type: "tuple", components: [...AUX_OUTPUT_COMPONENTS] },
] as const;

/**
 * Values for {@link DEPOSIT_WITH_AUX_PARAMS}, built with the calldata path's
 * helpers so the hash and the submitted struct cannot disagree.
 */
function depositWithAux(deposit: DepositRequest, aux: AuxOutput, feeAux: AuxOutput) {
    return [depositTuple(deposit), auxTuple(aux), auxTuple(feeAux)];
}

/**
 * `keccak256(abi.encode(aux)) mod r` over the whole `AuxValidation.Output`
 * array: binds the encrypted-note payloads the relayer carries in calldata.
 * Mirrors `PubInputs.sol`, which must recompute it from the aux calldata, not
 * accept it as an input.
 *
 * The clue fields are bound per output; this digest covers `ephPub` and
 * `ciphertext` as well. Without it a relayer could keep the clue intact (the
 * proof verifies and the recipient's FMD scan flags the note) while corrupting
 * the payload, leaving the recipient unable to open a note whose inputs are
 * already spent.
 *
 * Encoded as a dynamic `tuple[]`, so the array length is part of the preimage.
 */
export function auxDigest(aux: readonly AuxOutput[]): Field {
    const encoded = encodeAbiParameters(
        [{ type: "tuple[]", components: [...AUX_OUTPUT_COMPONENTS] }],
        [aux.map(auxTuple)],
    );
    return BigInt(keccak256(encoded)) % BN254_FR;
}

/**
 * `PubInputs.Transact.intentHash` for a swap's withdraw leg:
 * `uint256(keccak256(abi.encode(refundTo, tokenOut, minOut, adapter, deadline,
 * deposit_d, aux_d, fee_aux_d, refund_d, refund_aux_d, refund_fee_aux_d)))
 * mod r`. Mirrors `SwapWrapper._intentHash`; `swap` reverts `IntentMismatch`
 * when the proof's word differs.
 *
 * Takes the swap blob, so the hash is computed from the values the relayer is
 * asked to submit. It covers every field the submitter could otherwise rewrite:
 * the output and refund notes, their payloads, the slippage floor, the venue,
 * the expiry and the refund owner of a cancelled escrow. `tokenIn`, `amountIn`
 * and `route` are not covered: the withdraw leg pins what is spent, and for any
 * route the wrapper holds the output to `minOut`.
 *
 * Reduced mod r because the word is a circuit field element; the contract
 * reduces the same way before comparing.
 *
 * Addresses go through `abiAddress` because `adapter` and `tokenOut` arrive from
 * the quoter and the registry in arbitrary case.
 */
export function swapIntentHash(
    swap: Pick<
        SwapBlob,
        | "refundTo"
        | "tokenOut"
        | "minOut"
        | "adapter"
        | "deadline"
        | "depositD"
        | "auxD"
        | "feeAuxD"
        | "refundD"
        | "refundAuxD"
        | "refundFeeAuxD"
    >,
): Field {
    const encoded = encodeAbiParameters(
        [
            { type: "address" },
            { type: "address" },
            { type: "uint256" },
            { type: "address" },
            { type: "uint256" },
            ...DEPOSIT_WITH_AUX_PARAMS,
            ...DEPOSIT_WITH_AUX_PARAMS,
        ],
        [
            abiAddress(swap.refundTo),
            abiAddress(swap.tokenOut),
            swap.minOut,
            abiAddress(swap.adapter),
            swap.deadline,
            ...depositWithAux(
                swap.depositD,
                auxOutputToWire(swap.auxD),
                auxOutputToWire(swap.feeAuxD),
            ),
            ...depositWithAux(
                swap.refundD,
                auxOutputToWire(swap.refundAuxD),
                auxOutputToWire(swap.refundFeeAuxD),
            ),
        ] as never,
    );
    return BigInt(keccak256(encoded)) % BN254_FR;
}
