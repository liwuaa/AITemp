/**
 * Local QQ Music MCP for Xiaozhi:
 * play / search / play url / recent / cache / auth — with request cache & management.
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
import { resolveProxyHost } from "./lib/resolve-proxy-host.mjs";

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
const PROXY_HOST = resolveProxyHost(process.env.MUSIC_PROXY_HOST);
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
  version: "1.1.0",
});

server.registerTool(
  "qq_music_play",
  {
    description:
      "【用户要听歌时优先用这个】解析歌曲并返回设备可播的 pcm_url。" +
      "立刻调用 self.music.play_url，url 只能用 pcm_url（http://电脑IP:3210/proxy/pcm?...）。" +
      "禁止使用 cdn_url / https。",
    inputSchema: {
      keyword: z
        .string()
        .optional()
        .describe("Song/artist keyword to play, e.g. 晴天 周杰伦"),
      songmid: z
        .string()
        .optional()
        .describe("Optional QQ Music songmid; skips search if provided"),
      index: z
        .number()
        .int()
        .min(0)
        .max(14)
        .optional()
        .describe("Which search hit to play, default 0 (first)"),
      quality: z
        .string()
        .optional()
        .describe("Audio quality, default 128 (mp3)"),
    },
  },
  async ({ keyword, songmid, index, quality }) =>
    textResult(
      await playManager.playSong({
        keyword: keyword || "",
        songmid: songmid || "",
        index: index ?? 0,
        quality: quality || "128",
      })
    )
);

server.registerTool(
  "qq_music_search_songs",
  {
    description:
      "仅在用户只要「搜歌/查歌」时使用。若用户要播放，请改用 qq_music_play，" +
      "再调用设备 self.music.play_url。本工具不会让设备出声。",
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
      "根据 songmid 取 MP3 的 cdn_url/proxy_url。取到后必须再调用设备 self.music.play_url 才会播放。" +
      "用户直接说听歌时优先用 qq_music_play。",
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
        proxy_base: PROXY_BASE,
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

process.stderr.write(
  `[qq-music-local] proxy_base=${PROXY_BASE} (MUSIC_PROXY_HOST raw=${process.env.MUSIC_PROXY_HOST || ""})\n`
);

const transport = new StdioServerTransport();
await server.connect(transport);
