import { unstable_readConfig } from "wrangler";

const config = unstable_readConfig({ config: "wrangler.jsonc" });
const id = config.hyperdrive?.find((binding) => binding.binding === "HYPERDRIVE")?.id;
if (!/^[0-9a-f]{32}$/i.test(id ?? "") || /^0+$/.test(id)) {
  console.error("Set the HYPERDRIVE ID in wrangler.jsonc before deployment. Create it with query caching disabled.");
  process.exitCode = 1;
}
