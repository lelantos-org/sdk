// Accounts, addresses and published outputs for tests, built from leaf modules: no wallet graph.
// The one wallet import, `wallet/tx/outputs.ts`, has no runtime import inside the wallet layer.
//
// Not shipped: `src/**/*test-utils*` is excluded from the build, coverage and the layer check.

import type { OutputRecipient } from "../bundle/common.js";
import type { ShieldedAddress } from "../core/brand.js";
import { randomJubjubScalar } from "../core/random.js";
import { buildNoteCommitment, commitWithInner } from "../crypto/commit.js";
import type { Jubjub } from "../crypto/jubjub.js";
import type { Field, Poseidon } from "../crypto/poseidon.js";
import type { FmdClue } from "../fmd/clue.js";
import { FMD_DEFAULT_GAMMA } from "../fmd/keys.js";
import { type DecodedAddress, decodeAddress } from "../keys/address.js";
import {
    addressFromViewingKey,
    buildSpendingKey,
    type SpendingKey,
    type ViewingKey,
} from "../keys/keys.js";
import type { OutputAux, OutputAuxWithWitness } from "../notes/aux.js";
import { decodeNotePayload, type NotePayload, stripClueBitsPrefix } from "../notes/codec.js";
import { decryptNote } from "../notes/encrypt.js";
import type { Note } from "../notes/note.js";
import { auxOutputFromWire } from "../protocol/aux-wire.js";
import type { AuxOutput, DepositRequest } from "../protocol/deposit-request.js";
import type { ScanInput } from "../sync/scan.js";
import { padRecipient } from "../wallet/tx/outputs.js";

/** A random spending key and its default address. */
export function freshAccount(
    P: Poseidon,
    J: Jubjub,
): { keys: SpendingKey; address: ShieldedAddress } {
    const keys = buildSpendingKey(P, randomJubjubScalar());
    return { keys, address: addressFromViewingKey(P, J, keys) };
}

/** The address of `key` at diversifier `index`, decoded. */
export function recipientAt(P: Poseidon, J: Jubjub, key: ViewingKey, index = 0): DecodedAddress {
    return decodeAddress(J, addressFromViewingKey(P, J, key, index));
}

/** An address no one holds the keys of, as the wallet draws one for each pad slot. */
export function padAddress(J: Jubjub): OutputRecipient {
    return padRecipient(J);
}

/** The plaintext of a published output when `ivk` opens it, else `null`. */
export function openOutput(
    J: Jubjub,
    ivk: Field,
    output: Pick<OutputAux, "ephPub" | "ciphertext">,
): NotePayload | null {
    const plain = decryptNote({
        J,
        ivk,
        note: {
            epk: J.packPoint(output.ephPub),
            ciphertext: stripClueBitsPrefix(output.ciphertext).body,
        },
    });
    return plain && decodeNotePayload(plain);
}

/**
 * The clue of a published output, as `fmdTest` takes it. `output` is the builder's `OutputAux` or
 * a scanner's `ScanInput`, whose clue point is already packed.
 */
export function clueOf(
    J: Jubjub,
    output: Pick<OutputAux, "clueR" | "ciphertext"> | Pick<ScanInput, "clueR" | "ciphertext">,
): FmdClue {
    const { clueR, ciphertext } = output;
    return {
        R: clueR instanceof Uint8Array ? clueR : J.packPoint(clueR),
        // Low byte of the big-endian prefix: γ = 5 bits fit in it.
        bits: Uint8Array.of(stripClueBitsPrefix(ciphertext).prefix[1]!),
        gamma: FMD_DEFAULT_GAMMA,
    };
}

/** A published output as a scanner receives it: its points packed, at the leaf `at` names. */
export function scanInputOf(
    J: Jubjub,
    aux: OutputAux,
    at: Pick<ScanInput, "cm" | "leafIndex" | "blockNumber">,
): ScanInput {
    return {
        ciphertext: aux.ciphertext,
        epk: J.packPoint(aux.ephPub),
        clueR: J.packPoint(aux.clueR),
        cm: at.cm,
        leafIndex: at.leafIndex,
        blockNumber: at.blockNumber,
    };
}

/** What `sealOutput` returns, as a scanner receives it: the leaf is the note's commitment. */
export function sealedScanInput(
    P: Poseidon,
    J: Jubjub,
    sealed: { note: Note; aux: OutputAuxWithWitness },
    at: Pick<ScanInput, "leafIndex" | "blockNumber">,
): ScanInput {
    return scanInputOf(J, sealed.aux.aux, { cm: buildNoteCommitment(P, sealed.note), ...at });
}

/** Published outputs as a scanner receives them: slot `i` at leaf `i`, all in block 1. */
export function scanInputsOf(
    J: Jubjub,
    aux: readonly OutputAux[],
    cm: readonly Field[],
): ScanInput[] {
    return aux.map((a, i) => scanInputOf(J, a, { cm: cm[i]!, leafIndex: i, blockNumber: 1 }));
}

/**
 * A deposit's two leaves as the note feed serves them, the note at leaf 0 and the fee note at
 * leaf 1, both in block 1. Each leaf is the batch circuit's `cm` over the request's public fields.
 */
export function depositScanInputs(
    P: Poseidon,
    J: Jubjub,
    { deposit: d, aux, feeAux }: { deposit: DepositRequest; aux: AuxOutput; feeAux: AuxOutput },
): ScanInput[] {
    return scanInputsOf(
        J,
        [auxOutputFromWire(aux), auxOutputFromWire(feeAux)],
        [
            commitWithInner(P, d.publicAssetId, d.publicIn, BigInt(d.inner)),
            commitWithInner(P, d.feeAssetId, d.feeIn, BigInt(d.feeInner)),
        ],
    );
}
