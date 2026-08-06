import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(ROOT, "mcp", "qq_music_local_mcp.mjs")],
  env: {
    ...process.env,
    QQ_MUSIC_API_CONFIG_DIR: path.join(ROOT, "config"),
    USE_GLOBAL_COOKIE: "true",
    MUSIC_PROXY_HOST: "127.0.0.1",
    MUSIC_PROXY_PORT: "3210",
  },
});

const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const parse = (r) => JSON.parse(r.content[0].text);

const t0 = Date.now();
const s1 = parse(await client.callTool({ name: "qq_music_search_songs", arguments: { keyword: "晴天 周杰伦", limit: 3 } }));
const ms1 = Date.now() - t0;
console.log("SEARCH#1 ms=" + ms1, "count=" + (s1.data?.songs?.length ?? s1.songs?.length ?? "?"), "cached=" + (s1.cached ?? s1.data?.cached));
console.log("  sample:", JSON.stringify((s1.data?.songs ?? s1.songs ?? []).slice(0, 2)));

const t1 = Date.now();
const s2 = parse(await client.callTool({ name: "qq_music_search_songs", arguments: { keyword: "晴天 周杰伦", limit: 3 } }));
const ms2 = Date.now() - t1;
console.log("SEARCH#2 ms=" + ms2, "cached=" + (s2.cached ?? s2.data?.cached));

const stats = parse(await client.callTool({ name: "qq_music_cache_stats", arguments: {} }));
console.log("CACHE_STATS:", JSON.stringify(stats.data?.cache ?? stats.data));

const auth = parse(await client.callTool({ name: "qq_music_auth_status", arguments: {} }));
console.log("AUTH_STATUS:", JSON.stringify(auth.data));

await client.close();
console.log("SMOKE_TEST_OK");
process.exit(0);
