
export async function __block() {
const pay = x402(wallet, {
    budget:     { total: "5", perRequest: "0.10" },
    allowHosts: ["api.example.com"],
    onPayment:  (r) => audit.log(r),
});
}
