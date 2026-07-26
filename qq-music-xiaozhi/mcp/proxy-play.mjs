import http from "node:http";
import { URL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readUserAuth } from "./lib/auth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG_DIR =
  process.env.QQ_MUSIC_API_CONFIG_DIR || path.join(ROOT, "config");
const PORT = Number(process.env.MUSIC_PROXY_PORT || 3210);

process.env.QQ_MUSIC_API_CONFIG_DIR = CONFIG_DIR;
process.env.USE_GLOBAL_COOKIE = process.env.USE_GLOBAL_COOKIE || "true";

const { getMusicPlay } = await import("@sansenjian/qq-music-api/sdk");

function unwrap(result) {
  if (!result || typeof result !== "object") return {};
  if (result.body && typeof result.body === "object") return result.body;
  return result;
}

async function resolveCdnUrl(songmid, quality) {
  const auth = readUserAuth(CONFIG_DIR);
  if (!auth.cookie) {
    const err = new Error("need_relogin");
    err.statusCode = 401;
    throw err;
  }
  const result = await getMusicPlay({
    songmid,
    quality,
    cookie: auth.cookie,
  });
  const body = unwrap(result);
  const playMap = body?.data?.playUrl || {};
  const entry = playMap[songmid] || Object.values(playMap)[0];
  const url = entry?.url || "";
  if (!url) {
    const err = new Error("empty_play_url");
    err.statusCode = 502;
    throw err;
  }
  return url;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    const url = new URL(req.url || "/", `http://${host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "qq-music-proxy-play" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/proxy/play") {
      const songmid = (url.searchParams.get("songmid") || "").trim();
      const quality = (url.searchParams.get("quality") || "128").trim();
      if (!songmid) {
        sendJson(res, 400, { ok: false, error: "songmid_required" });
        return;
      }

      const cdnUrl = await resolveCdnUrl(songmid, quality);
      const upstream = await fetch(cdnUrl, {
        headers: {
          Referer: "https://y.qq.com/",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        redirect: "follow",
      });

      if (!upstream.ok || !upstream.body) {
        sendJson(res, 502, {
          ok: false,
          error: "upstream_failed",
          status: upstream.status,
        });
        return;
      }

      const contentType =
        upstream.headers.get("content-type") || "audio/mpeg";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });

      const reader = upstream.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value))) {
            await new Promise((resolve) => res.once("drain", resolve));
          }
        }
        res.end();
      };
      req.on("close", () => {
        try {
          reader.cancel();
        } catch {
          /* ignore */
        }
      });
      await pump();
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  } catch (error) {
    const status = error?.statusCode || 500;
    sendJson(res, status, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[proxy-play] listening on http://0.0.0.0:${PORT}`);
  console.log(`[proxy-play] config dir: ${CONFIG_DIR}`);
});
