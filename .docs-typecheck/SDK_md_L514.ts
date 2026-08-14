import { circuitAmount, hex32, type Submitter } from "@lelantos-org/sdk";
import type { SubmitTransactPayload } from "@lelantos-org/sdk/protocol";
export async function __block() {

class MockSubmitter implements Submitter {
    public lastPayload?: SubmitTransactPayload;
    async submit(p: SubmitTransactPayload) {
        this.lastPayload = p;
        // Implementing an SDK interface means producing its branded values;
        // the constructors validate as they brand.
        return { txHash: hex32(`0x${"de".repeat(32)}`) };
    }
}

const submitter = new MockSubmitter();
const wallet = await Wallet.create(keySource, { ...cfg, submitter });
await wallet.deposit({ amount: circuitAmount(100n) });
expect(submitter.lastPayload?.kind).toBe("deposit");
}
