
export async function __block() {
wallet.notes();                                    // every note, every asset
wallet.notes({ asset: 1n, spent: false });         // filter — both fields optional
wallet.balance(1n);                                // bigint, unspent only
wallet.balances();                                 // Map<assetId, bigint>, unspent only
}
