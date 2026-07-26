import { cacheKey } from "./request-cache.mjs";

function unwrap(result) {
  if (!result || typeof result !== "object") return {};
  if (result.body && typeof result.body === "object") return result.body;
  return result;
}

function pickSongFields(item) {
  const singers = Array.isArray(item.singer)
    ? item.singer.map((s) => s?.name).filter(Boolean).join("/")
    : item.singername || "";
  return {
    songmid: item.songmid || item.mid || "",
    songname: item.songname || item.name || "",
    singer: singers,
    albumname: item.albumname || item.album?.name || "",
    interval: item.interval || 0,
  };
}

/**
 * @param {object} deps
 * @param {import('./request-cache.mjs').RequestCache} deps.cache
 * @param {import('./request-manager.mjs').RequestManager} deps.requests
 * @param {() => string} deps.getCookie
 * @param {{ searchTtlMs: number, playTtlMs: number, recentMax: number, searchLimit: number, proxyBaseUrl: string }} deps.config
 * @param {{ search: Function, getMusicPlay: Function }} deps.sdk
 */
export function createPlayManager(deps) {
  const { cache, requests, getCookie, config, sdk } = deps;
  /** @type {Array<{ songmid: string, songname: string, singer: string, cdn_url: string, proxy_url: string, at: number }>} */
  const recent = [];

  function pushRecent(entry) {
    const idx = recent.findIndex((r) => r.songmid === entry.songmid);
    if (idx >= 0) recent.splice(idx, 1);
    recent.unshift(entry);
    while (recent.length > config.recentMax) recent.pop();
  }

  async function searchSongs(keyword, limit = config.searchLimit) {
    const keyWord = String(keyword || "").trim();
    if (!keyWord) {
      return { ok: false, error: "keyword_required", message: "keyword is required" };
    }
    const lim = Math.min(Math.max(Number(limit) || config.searchLimit, 1), 15);
    const key = cacheKey(["search", keyWord, lim]);
    const cached = cache.get(key);
    if (cached) {
      return { ok: true, cached: true, tool: "qq_music_search_songs", data: cached };
    }

    const data = await requests.singleflight(key, async () => {
      const result = await sdk.search({ key: keyWord, limit: lim, page: 1 });
      const body = unwrap(result);
      const list = body?.response?.data?.song?.list || body?.data?.song?.list || [];
      const songs = (Array.isArray(list) ? list : []).map(pickSongFields).filter((s) => s.songmid);
      return {
        keyword: keyWord,
        count: songs.length,
        songs,
      };
    });

    cache.set(key, data, config.searchTtlMs);
    return { ok: true, cached: false, tool: "qq_music_search_songs", data };
  }

  async function getPlayUrl(songmid, quality = "128", songname = "", singer = "") {
    const mid = String(songmid || "").trim();
    if (!mid) {
      return { ok: false, error: "songmid_required", message: "songmid is required" };
    }
    const q = String(quality || "128");
    const cookie = getCookie();
    if (!cookie) {
      return {
        ok: false,
        error: "need_relogin",
        message: "No QQ Music cookie. Run start.bat QR login first.",
      };
    }

    const key = cacheKey(["play", mid, q]);
    const cached = cache.get(key);
    if (cached) {
      return { ok: true, cached: true, tool: "qq_music_get_play_url", data: cached };
    }

    try {
      const data = await requests.singleflight(key, async () => {
        const result = await sdk.getMusicPlay({
          songmid: mid,
          quality: q,
          cookie,
        });
        const body = unwrap(result);
        const playMap = body?.data?.playUrl || body?.playUrl || {};
        const entry = playMap[mid] || Object.values(playMap)[0];
        const cdnUrl = entry?.url || entry?.purl || "";
        if (!cdnUrl) {
          const err = new Error("empty_play_url");
          err.code = "empty_play_url";
          throw err;
        }
        const proxyUrl = `${config.proxyBaseUrl.replace(/\/$/, "")}/proxy/play?songmid=${encodeURIComponent(mid)}&quality=${encodeURIComponent(q)}`;
        return {
          songmid: mid,
          songname: songname || "",
          singer: singer || "",
          quality: q,
          cdn_url: cdnUrl,
          proxy_url: proxyUrl,
          expires_hint_sec: Math.floor(config.playTtlMs / 1000),
        };
      });

      cache.set(key, data, config.playTtlMs);
      pushRecent({
        songmid: data.songmid,
        songname: data.songname,
        singer: data.singer,
        cdn_url: data.cdn_url,
        proxy_url: data.proxy_url,
        at: Date.now(),
      });
      return { ok: true, cached: false, tool: "qq_music_get_play_url", data };
    } catch (error) {
      cache.delete(key);
      const message = error instanceof Error ? error.message : String(error);
      if (/cookie|login|auth|401|403/i.test(message)) {
        return {
          ok: false,
          error: "need_relogin",
          message: "Cookie may be invalid. Re-run QR login.",
        };
      }
      return {
        ok: false,
        error: error?.code || "play_url_failed",
        message,
      };
    }
  }

  function listRecent() {
    return {
      ok: true,
      tool: "qq_music_recent",
      data: {
        count: recent.length,
        items: recent.map((r) => ({
          songmid: r.songmid,
          songname: r.songname,
          singer: r.singer,
          proxy_url: r.proxy_url,
          at: r.at,
        })),
      },
    };
  }

  return {
    searchSongs,
    getPlayUrl,
    listRecent,
  };
}
