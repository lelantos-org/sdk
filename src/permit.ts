// EIP-2612 permit signing helper.
//
// Wallet flow: read the deposit token's `name()` (for the EIP-712 domain)
// and `nonces(payer)`, build the standard `Permit` typed-data over
// `{ owner, spender, value, nonce, deadline }`, and have the payer sign it.
// The relayer then submits `MASP.transactWithPermit` carrying the (v, r, s).
//
// Domain matches OZ's ERC20Permit: `{ name, version: "1", chainId, verifyingContract }`.

import { type Signer, Signature, type TypedDataDomain } from "ethers";

export interface Erc2612Permit {
    /// Decimal U256 string — caller passes a bigint and we stringify.
    value: string;
    /// Unix-seconds expiry as a number (fits u53 well past 2106).
    deadline: number;
    v: number;
    /// 0x-hex 32 B.
    r: string;
    /// 0x-hex 32 B.
    s: string;
}

export interface SignPermitArgs {
    /// Payer's signer; must produce signatures over EIP-712 typed data.
    signer: Signer;
    /// ERC20 token contract address.
    token: string;
    /// Token's `name()` — must match the domain the token uses for permit.
    tokenName: string;
    /// Domain version. OZ ERC20Permit defaults to "1"; pass explicitly only
    /// for tokens that diverge.
    tokenVersion?: string;
    chainId: bigint;
    /// MASP contract address (the spender being approved).
    spender: string;
    /// Approval amount in token base units. Should equal `inAmt + fee`.
    value: bigint;
    /// Token's permit nonce for the payer — read via `IERC20Permit.nonces(owner)`.
    nonce: bigint;
    /// Unix-seconds expiry. Permit reverts on-chain past this.
    deadline: bigint;
}

const PERMIT_TYPES: Record<string, { name: string; type: string }[]> = {
    Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
    ],
};

export async function signErc2612Permit(args: SignPermitArgs): Promise<Erc2612Permit> {
    const owner = await args.signer.getAddress();
    const domain: TypedDataDomain = {
        name: args.tokenName,
        version: args.tokenVersion ?? "1",
        chainId: args.chainId,
        verifyingContract: args.token,
    };
    const message = {
        owner,
        spender: args.spender,
        value: args.value,
        nonce: args.nonce,
        deadline: args.deadline,
    };
    const sigHex = await args.signer.signTypedData(domain, PERMIT_TYPES, message);
    const sig = Signature.from(sigHex);
    return {
        value: args.value.toString(),
        deadline: Number(args.deadline),
        v: sig.v,
        r: sig.r,
        s: sig.s,
    };
}
