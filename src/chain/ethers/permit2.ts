// Permit2-side helpers: SignatureTransfer (witness) for one-shot deposits +
// AllowanceTransfer for hot-wallet flows. Read-only allowance lookup +
// nonce minting also live here.

import { Contract } from "ethers";
import {
    type Permit2Sig,
    type PermitSingle,
    signPermit2Allowance,
    signPermit2Witness,
} from "../../bundle/permit2.js";
import { TxMiningError } from "../../wallet/errors/index.js";
import type { Permit2SignArgs } from "../adapter.js";
import type { EthersChainAdapter } from "../ethers-adapter.js";

const PERMIT2_ALLOWANCE_VIEW_ABI = [
    "function allowance(address user,address token,address spender) view returns (uint160,uint48,uint48)",
];

const PERMIT2_PERMIT_ABI = [
    "function permit(address owner,((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline) permitSingle,bytes signature)",
];

export async function signPermit2(
    adapter: EthersChainAdapter,
    args: Permit2SignArgs,
): Promise<Permit2Sig> {
    const cid = await adapter.chainId();
    return signPermit2Witness({
        signer: adapter.signer,
        chainId: cid,
        spender: adapter.maspAddressSync(),
        token: args.token,
        maxTotal: args.maxTotal,
        nonce: args.nonce,
        deadline: args.deadline,
        piHash: args.piHash,
        permit2Address: adapter.permit2Address(),
    });
}

export async function signPermit2AllowanceFn(
    adapter: EthersChainAdapter,
    permit: PermitSingle,
): Promise<{ signature: string }> {
    const cid = await adapter.chainId();
    const r = await signPermit2Allowance({
        signer: adapter.signer,
        chainId: cid,
        permit,
        permit2Address: adapter.permit2Address(),
    });
    return { signature: r.signature };
}

export async function permit2Allowance(
    adapter: EthersChainAdapter,
    token: string,
    owner: string,
    spender: string,
): Promise<{ amount: bigint; expiration: number; nonce: number }> {
    const c = new Contract(adapter.permit2Address(), PERMIT2_ALLOWANCE_VIEW_ABI, adapter.provider);
    const r = (await c.allowance(owner, token, spender)) as [bigint, bigint, bigint];
    return { amount: r[0], expiration: Number(r[1]), nonce: Number(r[2]) };
}

export async function permit2PermitAllowance(
    adapter: EthersChainAdapter,
    args: { owner: string; permit: PermitSingle; signature: string },
    onTxHash?: (hash: string) => void,
): Promise<{ txHash: string }> {
    const c = new Contract(adapter.permit2Address(), PERMIT2_PERMIT_ABI, adapter.signer);
    const tx = await c.permit(
        args.owner,
        [
            [
                args.permit.details.token,
                args.permit.details.amount,
                args.permit.details.expiration,
                args.permit.details.nonce,
            ],
            args.permit.spender,
            args.permit.sigDeadline,
        ],
        args.signature,
    );
    onTxHash?.(tx.hash);
    const receipt = await tx.wait();
    if (!receipt) throw new TxMiningError("permit2PermitAllowance: no receipt");
    return { txHash: receipt.hash as string };
}

/// Permit2 uses an unordered-nonce bitmap. Timestamp-derived word; collision
/// odds negligible for human-rate signing. Override for stronger guarantees.
export async function permit2Nonce(): Promise<bigint> {
    const word = BigInt(Date.now()) << 8n;
    return word | BigInt(Math.floor(Math.random() * 256));
}
