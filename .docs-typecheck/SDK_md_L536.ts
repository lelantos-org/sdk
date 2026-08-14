import { circuitAmount, type CoinSelector, type SelectionResult, type StoredNote } from "@lelantos-org/sdk";
export async function __block() {

class LargestFirstSelector implements CoinSelector {
    select(all: readonly StoredNote[], asset: bigint, target: bigint): SelectionResult {
        const desc = all
            .filter((n) => !n.spent && BigInt(n.asset) === asset)
            .sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
        const notes = desc.slice(0, 2);
        const sum = notes.reduce((s, n) => s + BigInt(n.value), 0n);
        if (sum < target) throw new Error("insufficient");
        return { plan: "direct", notes, sum: circuitAmount(sum) };
    }
}

const wallet = await Wallet.create(keySource, { ...cfg, selector: new LargestFirstSelector() });
}
