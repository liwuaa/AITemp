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
        const pcmUrl = `${config.proxyBaseUrl.replace(/\/$/, "")}/proxy/pcm?songmid=${encodeURIComponent(mid)}&quality=${encodeURIComponent(q)}`;
        return {
          songmid: mid,
          songname: songname || "",
          singer: singer || "",
          quality: q,
          cdn_url: cdnUrl,
          proxy_url: proxyUrl,
          pcm_url: pcmUrl,
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
        pcm_url: data.pcm_url,
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

  /**
   * One-shot: resolve a playable URL and tell the LLM to call the device tool next.
   * Xiaozhi often stops after search; this collapses search+get_url and forces the handoff.
   */
  async function playSong({ keyword = "", songmid = "", index = 0, quality = "128" } = {}) {
    let mid = String(songmid || "").trim();
    let songname = "";
    let singer = "";
    let picked = null;

    if (!mid) {
      const keyWord = String(keyword || "").trim();
      if (!keyWord) {
        return {
          ok: false,
          error: "keyword_or_songmid_required",
          message: "Provide keyword or songmid",
        };
      }
      const search = await searchSongs(keyWord, config.searchLimit);
      if (!search.ok || !search.data?.songs?.length) {
        return {
          ok: false,
          error: "no_results",
          message: search.message || "No songs found",
          search,
        };
      }
      const idx = Math.min(Math.max(Number(index) || 0, 0), search.data.songs.length - 1);
      picked = search.data.songs[idx];
      mid = picked.songmid;
      songname = picked.songname;
      singer = picked.singer;
    }

    const play = await getPlayUrl(mid, quality || "128", songname, singer);
    if (!play.ok) {
      return { ...play, picked };
    }

    const title = [play.data.songname || songname, play.data.singer || singer]
      .filter(Boolean)
      .join(" - ");
    // Device only plays LAN PCM (/proxy/pcm). CDN/HTTPS and on-device MP3 are unstable.
    const playUrl = play.data.pcm_url || play.data.proxy_url?.replace("/proxy/play", "/proxy/pcm");
    return {
      ok: true,
      tool: "qq_music_play",
      must_call_next: true,
      instruction_zh:
        "用户要听歌：立刻调用设备工具 self.music.play_url，" +
        "url 必须用返回的 pcm_url（http://电脑局域网IP:3210/proxy/pcm?...），不要用 cdn_url/https。",
      instruction_en:
        "REQUIRED NEXT: call self.music.play_url with pcm_url only (never cdn_url/https).",
      device_tool: "self.music.play_url",
      device_arguments: {
        url: playUrl,
        title: title || play.data.songmid,
      },
      data: {
        ...play.data,
        songname: play.data.songname || songname,
        singer: play.data.singer || singer,
        preferred_url: playUrl,
        picked,
      },
    };
  }

  return {
    searchSongs,
    getPlayUrl,
    playSong,
    listRecent,
  };
}
