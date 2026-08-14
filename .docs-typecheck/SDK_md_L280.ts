
export async function __block() {
const r = await wallet.sync({ limit: 1000 });
// { fetched, hits, added, skipped }
}
