// Byte-equality tests for encoding primitives. Every pin comes from an implementation other than
// the one under test, and a shifted hash breaks wire compatibility:
//
// - `lelantosTypedDataHash`: generated with ethers@6 (`TypedDataEncoder.hash`). A shift makes nsk
//   caches diverge, so every shielded address regenerates.
// - `computePiHash`: the Solidity golden `PI_HASH_GOLDEN` from
//   `MASPPermit2WitnessTest.test_piHash_isStableForFixedFixture` (contracts,
//   `keccak256(abi.encode(d, aux, feeAux))` over the same fixture). A shift makes on-chain
//   `submitDeposit` revert: the contract recomputes the hash and checks it against the Permit2
//   witness.
// - `auxDigest`: re-derived here from the ABI spec and hashed with `@noble/hashes`. A shift moves
//   the final challenge word, so `PubInputs.sol` derives a different `z` from calldata and the
//   SNARK fails to verify.
// - `fiatShamirZ`: generated with ethers@6 (`AbiCoder.defaultAbiCoder().encode`, `keccak256`). A
//   shift makes SNARK verification and relayer batching diverge.
// - `tests/vectors/diversified.json` (`address_bech32`, `dvk_hex`, `osk_hex`, `rseed_hex`,
//   `rcm_dec`, `esk_dec`, `fmd_r_dec`, `plaintext_hex`, `ciphertext_hex`, the deposit `rho_dec`):
//   re-derived here from the layouts, with `bech32`, `@noble/hashes` and `@noble/ciphers` called
//   directly on the inputs the file gives. Every string of the file's `domains` block is hashed
//   into one of them, so the block cannot name a string the implementation does not use. A shift
//   means addresses stop decoding or the backend stops opening notes.
//
// Update these constants only with a contract/relayer upgrade that bumps the corresponding domain
// version.
//
// The `computePiHash` vector covers the two-output `DepositRequest` (the depositor's note and the
// relayer's fee note, with its `feeAssetId`). `abi-hash.test.ts` derives the component list from
// the Foundry ABI.

import { readFileSync } from "node:fs";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { blake2b } from "@noble/hashes/blake2";
import { keccak_256 } from "@noble/hashes/sha3";
import { concatBytes } from "@noble/hashes/utils";
import { bech32m } from "bech32";
import { beforeAll, describe, expect, it } from "vitest";
import { fiatShamirZ } from "./circuit/index.js";
import { BN254_FR } from "./core/field.js";
import { hexToBytes } from "./core/hex.js";
import { Jubjub } from "./crypto/jubjub-wasm/index.js";
import { lelantosTypedDataHash } from "./keys/metamask.js";
import { auxDigest, computePiHash } from "./protocol/abi-hash.js";
import type { AuxOutput, DepositRequest } from "./protocol/deposit-request.js";
import type { DiversifiedVectors } from "./test-utils/diversified-vectors.js";

const PINNED = {
    lelantosTypedDataHash: "0xaf9b4003f47701e282c9f5934e4ea6e5fe0f794e18c0e12c60bb6ba68ee3a93f",
    computePiHash: "0x030058819cc1757b096ad82a79ef0a7d881ecc0eabcaaa6d0bba8f10d3211f3d",
    auxDigest: "0x1f26acd333dba6acf234b651195b133dd42ddfd9ff4cf699d8fa39c25cdd085b",
    fiatShamirZ: "0x09749a91edf59dfc22cb354dc68e01ed58df7cd957ee08c5e8623f0f9374d29b",
} as const;

/** The two aux outputs of the `auxDigest` vector. */
const AUX: [AuxOutput, AuxOutput] = [
    {
        clueRx: 1n,
        clueRy: 2n,
        clueQx: 9n,
        clueQy: 10n,
        ephPubX: 3n,
        ephPubY: 4n,
        ciphertext: new Uint8Array([0xab, 0xcd, 0xef]),
    },
    {
        clueRx: 5n,
        clueRy: 6n,
        clueQx: 11n,
        clueQy: 12n,
        ephPubX: 7n,
        ephPubY: 8n,
        ciphertext: new Uint8Array([0x12, 0x34]),
    },
];

/** `MASPPermit2WitnessTest._fixtureDeposit`, field for field. */
const INTENT: DepositRequest = {
    chainId: 31337n,
    publicAssetId: 1n,
    publicIn: 100n,
    payer: "0x000000000000000000000000000000000000face",
    recipient: "0x0000000000000000000000000000000000000b0b",
    inner: `0x${"1111".padStart(64, "0")}`,
    feeAssetId: 1n,
    feeIn: 7n,
    feeInner: `0x${"2222".padStart(64, "0")}`,
};

/** `_fixtureAux` and `_fixtureFeeAux`: distinct in every field, so a swapped payload shows. */
const PI_AUX: [AuxOutput, AuxOutput] = [
    {
        clueRx: 0x111n,
        clueRy: 0x112n,
        clueQx: 0x115n,
        clueQy: 0x116n,
        ephPubX: 0x113n,
        ephPubY: 0x114n,
        ciphertext: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    },
    {
        clueRx: 0x221n,
        clueRy: 0x222n,
        clueQx: 0x225n,
        clueQy: 0x226n,
        ephPubX: 0x223n,
        ephPubY: 0x224n,
        ciphertext: new Uint8Array([0xfe, 0xed, 0xfa, 0xce]),
    },
];

describe("encoding parity (independent implementation → viem)", () => {
    it("lelantosTypedDataHash matches the pinned ethers output", () => {
        expect(lelantosTypedDataHash()).toBe(PINNED.lelantosTypedDataHash);
    });

    it("computePiHash matches the Solidity golden for the canonical fixture", () => {
        expect(computePiHash(INTENT, PI_AUX[0], PI_AUX[1])).toBe(PINNED.computePiHash);
    });

    it("computePiHash agrees with the layout spelled out from the ABI spec", () => {
        // The pin alone would not detect a change applied to both sides. `DepositRequest` is
        // static (9 words), so the preimage is those words, then one offset per dynamic aux tuple,
        // each with a nested offset for its `ciphertext`.
        const encoded = encodePiHashFromSpec(INTENT, PI_AUX[0], PI_AUX[1]);
        // 9 deposit + 2 offsets + 9 per aux (6 static + offset + len + data)
        expect(encoded.length / 32).toBe(29);
        expect(bytesToHexWord(keccak_256(encoded))).toBe(PINNED.computePiHash);
    });

    it("auxDigest matches the pinned output for the canonical fixture", () => {
        expect(hex32(auxDigest(AUX))).toBe(PINNED.auxDigest);
    });

    it("auxDigest agrees with the layout spelled out from the ABI spec", () => {
        // The preimage is re-derived from the encoding rules and hashed with `@noble/hashes`, so
        // the vector rests on the spec rather than on `encodeAbiParameters`. `auxDigest` is a
        // dynamic `tuple[]` whose element type is itself dynamic (`ciphertext bytes`): a length
        // word, an offset per element, and a nested offset inside each element.
        const encoded = encodeAuxArrayFromSpec(AUX);
        expect(encoded.length / 32).toBe(22); // 1 offset + 1 length + 2 heads + 9 + 9
        expect(BigInt(bytesToHexWord(keccak_256(encoded))) % BN254_FR).toBe(auxDigest(AUX));
    });

    it("fiatShamirZ matches the pinned ethers output for the canonical fixture", () => {
        // Verifies the `encodeAbiParameters` path mirrors ethers `AbiCoder`'s
        // `["uint256[]"]` packing (ethers stringified each coeff).
        const coeffs = [1n, 2n, 3n, 100n, 999n];
        const z = fiatShamirZ(coeffs);
        expect(`0x${z.toString(16).padStart(64, "0")}`).toBe(PINNED.fiatShamirZ);
    });
});

describe("encoding parity (diversified vectors → layouts spelled out from the spec)", () => {
    const file: DiversifiedVectors = JSON.parse(
        readFileSync(new URL("../tests/vectors/diversified.json", import.meta.url), "utf8"),
    );
    let J: Jubjub;
    beforeAll(async () => {
        J = await Jubjub.build();
    });

    it("address_bech32 is bech32m over d || pk_d || pk || ck_d", () => {
        expect(file.address_hrp).toBe("lelantos");
        for (const a of file.addresses) {
            const payload = addressPayload(a);
            expect(payload).toHaveLength(112);
            expect(bech32m.encode(file.address_hrp, bech32m.toWords(payload), 256)).toBe(
                a.address_bech32,
            );
        }
    });

    it("dvk_hex is blake2b-128 over the dvk domain and ivk as 32 little-endian bytes", () => {
        for (const a of file.addresses) {
            const preimage = concatBytes(utf8(file.domains.dvk), leBytes(BigInt(a.ivk_dec), 32));
            expect(bytesToHexWord(blake2b(preimage, { dkLen: 16 }))).toBe(a.dvk_hex);
        }
    });

    it("osk_hex is blake2b-256 over the note, the whole address payload and the nullifiers", () => {
        for (const s of file.seed) {
            // The entry repeats the recipient fields of the address it pays.
            const payload = addressPayload(s);
            expect(payload).toEqual(addressPayload(file.addresses[s.address_index]!));
            const preimage = concatBytes(
                utf8(file.domains.osk),
                hexToBytes(s.ock_hex),
                leBytes(BigInt(s.chain_id_dec), 32),
                leBytes(BigInt(s.rho_dec), 32),
                leBytes(BigInt(s.asset_dec), 8),
                leBytes(BigInt(s.value_dec), 8),
                payload,
                Uint8Array.of(s.nullifiers_dec.length),
                ...s.nullifiers_dec.map((nf) => leBytes(BigInt(nf), 32)),
            );
            expect(bytesToHexWord(preimage)).toBe(s.osk_preimage_hex);
            expect(bytesToHexWord(blake2b(preimage, { dkLen: 32 }))).toBe(s.osk_hex);
        }
    });

    it("rseed_hex is blake2b-256 over the rseed domain and osk", () => {
        for (const s of file.seed) {
            const preimage = concatBytes(utf8(file.domains.rseed), hexToBytes(s.osk_hex));
            expect(bytesToHexWord(blake2b(preimage, { dkLen: 32 }))).toBe(s.rseed_hex);
        }
    });

    it("rcm, esk and fmd_r are blake2b-512 over their domain, rseed and rho, reduced", () => {
        const r = BigInt(file.constants.bn254_fr_dec);
        const q = BigInt(file.constants.babyjub_subgroup_order_dec);
        for (const s of file.seed) {
            const tail = concatBytes(hexToBytes(s.rseed_hex), leBytes(BigInt(s.rho_dec), 32));
            const wide = (domain: string) =>
                leInt(blake2b(concatBytes(utf8(domain), tail), { dkLen: 64 }));
            // `rcm` is a field element; the two scalars are in [1, q - 1].
            expect((wide(file.domains.rcm) % r).toString()).toBe(s.rcm_dec);
            expect(((wide(file.domains.esk) % (q - 1n)) + 1n).toString()).toBe(s.esk_dec);
            expect(((wide(file.domains.fmd_r) % (q - 1n)) + 1n).toString()).toBe(s.fmd_r_dec);
        }
    });

    it("a deposit's rho is blake2b-512 over the rho domain, ock and the nonce, mod r", () => {
        const r = BigInt(file.constants.bn254_fr_dec);
        for (const v of file.deposit_rho) {
            const preimage = concatBytes(
                utf8(file.domains.deposit_rho),
                hexToBytes(v.ock_hex),
                hexToBytes(v.nonce_hex),
            );
            expect((leInt(blake2b(preimage, { dkLen: 64 })) % r).toString()).toBe(v.rho_dec);
        }
    });

    it("plaintext_hex is asset || value || rho || rseed || d, little-endian", () => {
        for (const s of file.seed) {
            const plaintext = concatBytes(
                leBytes(BigInt(s.asset_dec), 8),
                leBytes(BigInt(s.value_dec), 8),
                leBytes(BigInt(s.rho_dec), 32),
                hexToBytes(s.rseed_hex),
                hexToBytes(s.d_bytes_hex),
            );
            expect(plaintext).toHaveLength(96);
            expect(bytesToHexWord(plaintext)).toBe(s.plaintext_hex);
        }
    });

    it("ciphertext_hex is the clue-bits prefix, then ChaCha20-Poly1305 under the blake2b key", () => {
        for (const s of file.seed) {
            const epk = hexToBytes(s.epk_packed_hex);
            const pkD = J.unpackPoint(hexToBytes(file.addresses[s.address_index]!.pk_d_packed_hex));
            const shared = J.packPoint(J.mulPointEscalar(pkD!, BigInt(s.esk_dec)));
            const key = blake2b(concatBytes(utf8(file.domains.kdf), epk, shared), { dkLen: 32 });
            const nonce = blake2b(concatBytes(utf8(file.domains.nonce), epk), { dkLen: 12 });
            const body = chacha20poly1305(key, nonce).encrypt(hexToBytes(s.plaintext_hex));

            // `clue_bits_hex` holds bit i at bit (i & 7) of byte (i >> 3); the prefix is that
            // integer as two big-endian bytes.
            const bits = hexToBytes(s.clue_bits_hex);
            const prefix = Uint8Array.of(bits[1] ?? 0, bits[0] ?? 0);

            const wire = concatBytes(prefix, body);
            expect(wire).toHaveLength(114);
            expect(bytesToHexWord(wire)).toBe(s.ciphertext_hex);
        }
    });

    it("the domains block lists only the strings the tests above hash", () => {
        expect(Object.keys(file.domains).sort()).toEqual(
            ["deposit_rho", "dvk", "esk", "fmd_r", "kdf", "nonce", "osk", "rcm", "rseed"].sort(),
        );
    });
});

/** `n` as `len` little-endian bytes. */
function leBytes(n: bigint, len: number): Uint8Array {
    return Uint8Array.from({ length: len }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
}

/** The integer `bytes` encode little-endian. */
function leInt(bytes: Uint8Array): bigint {
    return bytes.reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n);
}

function utf8(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

/** The address payload `d || pk_d || pk || ck_d`, from an entry's own recipient fields. */
function addressPayload(entry: {
    d_bytes_hex: string;
    pk_d_packed_hex: string;
    pk_dec: string;
    ck_d_packed_hex: string;
}): Uint8Array {
    return concatBytes(
        hexToBytes(entry.d_bytes_hex),
        hexToBytes(entry.pk_d_packed_hex),
        leBytes(BigInt(entry.pk_dec), 32),
        hexToBytes(entry.ck_d_packed_hex),
    );
}

/** 32-byte big-endian word. */
function word(n: bigint): string {
    return n.toString(16).padStart(64, "0");
}

function bytesToHexWord(b: Uint8Array): string {
    let h = "0x";
    for (const x of b) h += x.toString(16).padStart(2, "0");
    return h;
}

function hex32(n: bigint): string {
    return `0x${word(n)}`;
}

/**
 * `abi.encode((uint256,uint256,uint256,uint256,uint256,uint256,bytes)[])`, written out from
 * the ABI encoding rules.
 *
 * Head/tail layout, all offsets in bytes:
 *   [0]           offset to the array               = 0x20
 *   [0x20]        array length N
 *   [0x40 ..]     N element offsets, each relative to the first of them
 *   then, per element (a tuple with six static words and one dynamic):
 *                 clueRx, clueRy, clueQx, clueQy, ephPubX, ephPubY
 *                 offset to `ciphertext`, relative to the element start = 0xe0
 *                 ciphertext length, then its bytes right-padded to a word
 */
function encodeAuxArrayFromSpec(aux: readonly AuxOutput[]): Uint8Array {
    const elements = aux.map((a) => {
        const padded = new Uint8Array(Math.ceil(a.ciphertext.length / 32) * 32);
        padded.set(a.ciphertext);
        return (
            word(a.clueRx) +
            word(a.clueRy) +
            word(a.clueQx) +
            word(a.clueQy) +
            word(a.ephPubX) +
            word(a.ephPubY) +
            word(7n * 32n) +
            word(BigInt(a.ciphertext.length)) +
            bytesToHexWord(padded).slice(2)
        );
    });

    let offset = BigInt(elements.length * 32);
    let heads = "";
    for (const e of elements) {
        heads += word(offset);
        offset += BigInt(e.length / 2);
    }

    return hexToBytes(word(32n) + word(BigInt(elements.length)) + heads + elements.join(""));
}

/**
 * `abi.encode(DepositRequest, AuxValidation.Output, AuxValidation.Output)`, written out from the
 * ABI encoding rules.
 */
function encodePiHashFromSpec(d: DepositRequest, a: AuxOutput, fee: AuxOutput): Uint8Array {
    const depositWords = [
        word(d.chainId),
        word(d.publicAssetId),
        word(d.publicIn),
        word(BigInt(d.payer)),
        word(BigInt(d.recipient)),
        d.inner.slice(2),
        word(d.feeAssetId),
        word(d.feeIn),
        d.feeInner.slice(2),
    ];
    // Inside an aux tuple, `ciphertext` follows 6 static words + its offset.
    const CIPHERTEXT_OFFSET = 224n;
    const auxTail = (x: AuxOutput): string[] => {
        const pad = (32 - (x.ciphertext.length % 32)) % 32;
        const body =
            [...x.ciphertext].map((b) => b.toString(16).padStart(2, "0")).join("") +
            "00".repeat(pad);
        return [
            word(x.clueRx),
            word(x.clueRy),
            word(x.clueQx),
            word(x.clueQy),
            word(x.ephPubX),
            word(x.ephPubY),
            word(CIPHERTEXT_OFFSET),
            word(BigInt(x.ciphertext.length)),
            body,
        ];
    };
    const tail0 = auxTail(a);
    const tail1 = auxTail(fee);
    // The request is static and occupies 9 words; two offsets follow it, so
    // the tail begins at 11 * 32. The second offset skips the first tuple.
    const AUX_OFFSET = 352n;
    const FEE_AUX_OFFSET = AUX_OFFSET + BigInt(tail0.join("").length / 2);
    return hexToBytes(
        `0x${[...depositWords, word(AUX_OFFSET), word(FEE_AUX_OFFSET), ...tail0, ...tail1].join("")}`,
    );
}
