import { detectionKey } from "@lelantos-org/sdk";
import { cryptoContext, deriveSubscriptionToken } from "@lelantos-org/sdk/crypto";
import { FMD_SENDER_GAMMA, detectionKeyToHex, subscriptionTokenToHex } from "@lelantos-org/sdk/fmd";
import { FmdClient } from "@lelantos-org/sdk/fmd-server";
export async function __block() {

// Full firehose — no FMD on the server, maximum anonymity.
const full = await connect({ privateKey: pk, network: "anvil", rpcUrl });

// Server-side FMD — register a detection key under a token you derive.
// `epoch` is 0 until you rotate; see below for why it must be stored after that.
const { P } = await cryptoContext();
const epoch = BigInt(myAppConfig.subscriptionEpoch ?? 0);
const tokenHex = subscriptionTokenToHex(deriveSubscriptionToken(P, keys.ivk, epoch));
const detectionKeyHex = detectionKeyToHex(await detectionKey(viewingKey, FMD_SENDER_GAMMA));

const fmd = new FmdClient(fmdUrl, chainId);
await fmd.createSubscription({ detectionKeyHex, gamma: FMD_SENDER_GAMMA, tokenHex });

const matches = await connect({
    privateKey: pk,
    network: "anvil",
    rpcUrl,
    syncStrategy: { kind: "matches", token: tokenHex },
});
}
