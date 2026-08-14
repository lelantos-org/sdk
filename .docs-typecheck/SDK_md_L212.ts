import { isWalletError } from "@lelantos-org/sdk";
export async function __block() {

try {
    await wallet.transfer({ to, amount });
} catch (e) {
    if (isWalletError(e, "INSUFFICIENT_COVER")) {
        // `e.consolidate` / `e.consolidateSum` are typed here — no `instanceof`.
        console.log("consolidate first:", e.consolidate.map((n) => n.id), e.consolidateSum);
    } else throw e;
}
}
