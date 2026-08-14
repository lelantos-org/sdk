
export async function __block() {
const wallet = await Wallet.create(
    { type: "nsk", nsk: 0xdeadbeefn },
    config,
);
}
