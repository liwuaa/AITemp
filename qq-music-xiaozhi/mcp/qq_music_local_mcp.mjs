/**
 * Local QQ Music MCP for Xiaozhi:
 * search / play url / recent / cache / auth — with request cache & management.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { RequestCache } from "./lib/request-cache.mjs";
import { RequestManager } from "./lib/request-manager.mjs";
import { readUserAuth, cookieKeyNames } from "./lib/auth.mjs";
import { createPlayManager } from "./lib/play-manager.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG_DIR =
  process.env.QQ_MUSIC_API_CONFIG_DIR || path.join(ROOT, "config");

process.env.QQ_MUSIC_API_CONFIG_DIR = CONFIG_DIR;
process.env.USE_GLOBAL_COOKIE = process.env.USE_GLOBAL_COOKIE || "true";

const SEARCH_TTL_MS = Number(process.env.MCP_CACHE_TTL_SEARCH || 10 * 60 * 1000);
const PLAY_TTL_MS = Number(process.env.MCP_CACHE_TTL_PLAY || 5 * 60 * 1000);
const MAX_ENTRIES = Number(process.env.MCP_CACHE_MAX_ENTRIES || 200);
const CONCURRENCY = Number(process.env.MCP_UPSTREAM_CONCURRENCY || 4);
const SEARCH_LIMIT = Number(process.env.MCP_SEARCH_LIMIT || 8);
const RECENT_MAX = Number(process.env.MCP_RECENT_MAX || 20);
const PROXY_PORT = Number(process.env.MUSIC_PROXY_PORT || 3210);
const PROXY_HOST = process.env.MUSIC_PROXY_HOST || "127.0.0.1";
const PROXY_BASE = `http://${PROXY_HOST}:${PROXY_PORT}`;

const { search, getMusicPlay } = await import("@sansenjian/qq-music-api/sdk");

const cache = new RequestCache({
  maxEntries: MAX_ENTRIES,
  defaultTtlMs: SEARCH_TTL_MS,
});
const requests = new RequestManager({ concurrency: CONCURRENCY });
const playManager = createPlayManager({
  cache,
  requests,
  getCookie: () => readUserAuth(CONFIG_DIR).cookie,
  config: {
    searchTtlMs: SEARCH_TTL_MS,
    playTtlMs: PLAY_TTL_MS,
    recentMax: RECENT_MAX,
    searchLimit: SEARCH_LIMIT,
    proxyBaseUrl: PROXY_BASE,
  },
  sdk: { search, getMusicPlay },
});

function textResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

const server = new McpServer({
  name: "qq-music-local",
  version: "1.0.0",
});

server.registerTool(
  "qq_music_search_songs",
  {
    description:
      "Search QQ Music songs by keyword. Returns a short list with songmid/songname/singer. Use songmid with qq_music_get_play_url before asking the device to play.",
    inputSchema: {
      keyword: z.string().describe("Search keyword, e.g. song or artist name"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(15)
        .optional()
        .describe("Max results, default 8"),
    },
  },
  async ({ keyword, limit }) => textResult(await playManager.searchSongs(keyword, limit))
);

server.registerTool(
  "qq_music_get_play_url",
  {
    description:
      "Get a playable 128kbps MP3 URL for a QQ Music songmid. Returns cdn_url and proxy_url. Prefer proxy_url for ESP32 if CDN is blocked. Requires local QR login cookie.",
    inputSchema: {
      songmid: z.string().describe("QQ Music songmid from search results"),
      quality: z
        .string()
        .optional()
        .describe("Audio quality, default 128 (mp3)"),
      songname: z.string().optional().describe("Optional title for recent list"),
      singer: z.string().optional().describe("Optional singer for recent list"),
    },
  },
  async ({ songmid, quality, songname, singer }) =>
    textResult(await playManager.getPlayUrl(songmid, quality || "128", songname, singer))
);

server.registerTool(
  "qq_music_recent",
  {
    description:
      "List recently resolved play URLs in this MCP process (songmid/title/proxy_url).",
    inputSchema: {},
  },
  async () => textResult(playManager.listRecent())
);

server.registerTool(
  "qq_music_auth_status",
  {
    description:
      "Return redacted QQ Music login status. Never returns full cookie values.",
    inputSchema: {},
  },
  async () => {
    const auth = readUserAuth(CONFIG_DIR);
    return textResult({
      ok: true,
      tool: "qq_music_auth_status",
      data: {
        authenticated: auth.hasCookie && Boolean(auth.loginUin),
        uin: auth.loginUin || "",
        hasCookie: auth.hasCookie,
        cookieKeys: cookieKeyNames(auth.cookie),
        configDir: CONFIG_DIR,
      },
    });
  }
);

server.registerTool(
  "qq_music_cache_stats",
  {
    description: "Show MCP request cache and upstream concurrency stats.",
    inputSchema: {},
  },
  async () =>
    textResult({
      ok: true,
      tool: "qq_music_cache_stats",
      data: {
        cache: cache.stats(),
        requests: requests.stats(),
        ttl: {
          search_ms: SEARCH_TTL_MS,
          play_ms: PLAY_TTL_MS,
        },
        proxy_base: PROXY_BASE,
      },
    })
);

server.registerTool(
  "qq_music_cache_clear",
  {
    description: "Clear the in-memory MCP request cache.",
    inputSchema: {},
  },
  async () => {
    cache.clear();
    return textResult({
      ok: true,
      tool: "qq_music_cache_clear",
      data: { cleared: true, cache: cache.stats() },
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
