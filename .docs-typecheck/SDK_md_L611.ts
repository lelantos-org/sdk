import { Wallet, ViemChainAdapter, Eip1193Signer, InMemoryNoteStore } from "@lelantos-org/sdk";
export async function __block() {

// Wrap the EIP-1193 provider exposed by MetaMask (or any injected wallet).
await window.ethereum.request({ method: "eth_requestAccounts" });
const signer = new Eip1193Signer(window.ethereum, evmAddress(account), chainId);

const wallet = await Wallet.create(
    { type: "mnemonic", mnemonic },
    {
        ...config,
        chain: new ViemChainAdapter({
            rpcUrl: "...",
            signer,                  // any EthSigner (Eip1193Signer / PrivateKeySigner / custom)
            maspAddress: "0x...",
        }),
    },
);
}
