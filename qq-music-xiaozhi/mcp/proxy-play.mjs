import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { URL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";
import { readUserAuth } from "./lib/auth.mjs";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  const toolsDir = path.join(ROOT, "tools");
  const pathFile = path.join(toolsDir, "ffmpeg_path.txt");
  if (fs.existsSync(pathFile)) {
    const p = fs.readFileSync(pathFile, "utf8").trim();
    if (p && fs.existsSync(p)) return p;
  }
  try {
    const fromStatic = require("ffmpeg-static");
    if (fromStatic && fs.existsSync(fromStatic)) return fromStatic;
  } catch {
    /* optional */
  }
  try {
    const stack = [toolsDir];
    while (stack.length) {
      const dir = stack.pop();
      if (!dir || !fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) stack.push(full);
        else if (name.toLowerCase() === "ffmpeg.exe") return full;
      }
    }
  } catch {
    /* ignore */
  }
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], {
    encoding: "utf8",
  });
  if (which.status === 0) {
    const line = String(which.stdout || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (line) return line;
  }
  return null;
}

const ffmpegPath = resolveFfmpeg();
const CONFIG_DIR =
  process.env.QQ_MUSIC_API_CONFIG_DIR || path.join(ROOT, "config");
const PORT = Number(process.env.MUSIC_PROXY_PORT || 3210);

process.env.QQ_MUSIC_API_CONFIG_DIR = CONFIG_DIR;
process.env.USE_GLOBAL_COOKIE = process.env.USE_GLOBAL_COOKIE || "true";

const { getMusicPlay } = await import("@sansenjian/qq-music-api/sdk");

function log(...args) {
  console.log(`[proxy-play ${new Date().toISOString()}]`, ...args);
}

function warn(...args) {
  console.warn(`[proxy-play ${new Date().toISOString()}]`, ...args);
}

function isBenignNetError(err) {
  const msg = String(err?.message || err || "");
  const code = err?.code || err?.cause?.code || "";
  return (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ECONNABORTED" ||
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    code === "ABORT_ERR" ||
    /terminated|aborted|ECONNRESET|EPIPE|premature close|AbortError/i.test(msg)
  );
}

// Keep proxy alive when CDN or device drops mid-stream.
process.on("uncaughtException", (err) => {
  if (isBenignNetError(err)) {
    warn("uncaught(benign):", err.message || err);
    return;
  }
  console.error("[proxy-play] uncaughtException", err);
});
process.on("unhandledRejection", (err) => {
  if (isBenignNetError(err)) {
    warn("unhandledRejection(benign):", err?.message || err);
    return;
  }
  console.error("[proxy-play] unhandledRejection", err);
});

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
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function safeEnd(res) {
  try {
    if (!res.writableEnded) res.end();
  } catch {
    /* ignore */
  }
}

function destroyQuiet(stream) {
  try {
    if (stream && !stream.destroyed) stream.destroy();
  } catch {
    /* ignore */
  }
}

async function fetchCdn(cdnUrl, signal) {
  return fetch(cdnUrl, {
    headers: {
      Referer: "https://y.qq.com/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    redirect: "follow",
    signal,
  });
}

async function pipeMp3ToPcm(cdnUrl, res, req, meta = {}) {
  if (!ffmpegPath) {
    sendJson(res, 500, { ok: false, error: "ffmpeg_missing" });
    return;
  }

  const ac = new AbortController();
  const cleanupFns = [];
  let closed = false;
  const cleanup = (why) => {
    if (closed) return;
    closed = true;
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
    for (const fn of cleanupFns) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    log("pcm.cleanup", { ...meta, why });
  };

  req.on("close", () => cleanup("req_close"));
  res.on("close", () => cleanup("res_close"));

  let upstream;
  try {
    upstream = await fetchCdn(cdnUrl, ac.signal);
  } catch (err) {
    if (isBenignNetError(err) || ac.signal.aborted) {
      warn("cdn.fetch aborted/reset", err.message || err);
      safeEnd(res);
      return;
    }
    throw err;
  }

  if (!upstream.ok || !upstream.body) {
    sendJson(res, 502, {
      ok: false,
      error: "upstream_failed",
      status: upstream.status,
    });
    return;
  }

  if (res.headersSent) return;
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "X-Pcm-Sample-Rate": "16000",
    "X-Pcm-Channels": "1",
    "X-Pcm-Bits": "16",
    "X-Pcm-Format": "s16le",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });

  const ff = spawn(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-ac",
      "1",
      "-ar",
      "16000",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  cleanupFns.push(() => {
    try {
      ff.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  });

  let stderr = "";
  ff.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 2000) stderr = stderr.slice(-2000);
  });
  ff.on("error", (err) => warn("ffmpeg error", err.message));
  ff.stdin.on("error", (err) => {
    if (!isBenignNetError(err)) warn("ffmpeg.stdin", err.message);
  });
  ff.stdout.on("error", (err) => {
    if (!isBenignNetError(err)) warn("ffmpeg.stdout", err.message);
  });

  const nodeIn = Readable.fromWeb(upstream.body);
  nodeIn.on("error", (err) => {
    if (isBenignNetError(err) || ac.signal.aborted) {
      warn("cdn.stream", err.message || err);
    } else {
      warn("cdn.stream error", err);
    }
    cleanup("cdn_error");
  });
  cleanupFns.push(() => destroyQuiet(nodeIn));
  cleanupFns.push(() => destroyQuiet(ff.stdin));
  cleanupFns.push(() => destroyQuiet(ff.stdout));

  let bytesOut = 0;
  const t0 = Date.now();
  ff.stdout.on("data", (chunk) => {
    bytesOut += chunk.length;
    if (closed || res.writableEnded) return;
    try {
      if (!res.write(chunk)) {
        ff.stdout.pause();
        res.once("drain", () => {
          if (!closed) ff.stdout.resume();
        });
      }
    } catch (err) {
      if (!isBenignNetError(err)) warn("res.write", err.message);
      cleanup("write_error");
    }
  });
  ff.stdout.on("end", () => {
    log("pcm.done", { ...meta, bytesOut, ms: Date.now() - t0 });
    safeEnd(res);
  });
  ff.on("close", (code) => {
    if (code && code !== 0) {
      warn("ffmpeg exit", code, stderr.slice(-300));
    }
    safeEnd(res);
  });

  try {
    await pipeline(nodeIn, ff.stdin);
  } catch (err) {
    if (!isBenignNetError(err) && !ac.signal.aborted) {
      warn("pipeline mp3->ffmpeg", err.message || err);
    }
    cleanup("pipeline_end");
  }
}

async function pipeMp3Raw(cdnUrl, res, req, meta = {}) {
  const ac = new AbortController();
  let closed = false;
  const cleanup = (why) => {
    if (closed) return;
    closed = true;
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
    log("mp3.cleanup", { ...meta, why });
  };
  req.on("close", () => cleanup("req_close"));
  res.on("close", () => cleanup("res_close"));

  let upstream;
  try {
    upstream = await fetchCdn(cdnUrl, ac.signal);
  } catch (err) {
    if (isBenignNetError(err) || ac.signal.aborted) {
      safeEnd(res);
      return;
    }
    throw err;
  }

  if (!upstream.ok || !upstream.body) {
    sendJson(res, 502, {
      ok: false,
      error: "upstream_failed",
      status: upstream.status,
    });
    return;
  }

  res.writeHead(200, {
    "Content-Type": upstream.headers.get("content-type") || "audio/mpeg",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });

  const nodeIn = Readable.fromWeb(upstream.body);
  nodeIn.on("error", (err) => {
    if (!isBenignNetError(err)) warn("raw.cdn", err.message);
    cleanup("cdn_error");
    safeEnd(res);
  });

  try {
    for await (const chunk of nodeIn) {
      if (closed) break;
      if (!res.write(chunk)) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }
  } catch (err) {
    if (!isBenignNetError(err) && !ac.signal.aborted) {
      warn("raw.pump", err.message || err);
    }
  }
  safeEnd(res);
}

const server = http.createServer(async (req, res) => {
  const ip = req.socket?.remoteAddress || "";
  try {
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    const url = new URL(req.url || "/", `http://${host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "qq-music-proxy-play",
        ffmpeg: Boolean(ffmpegPath),
        endpoints: ["/proxy/pcm", "/proxy/play"],
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/proxy/pcm") {
      const songmid = (url.searchParams.get("songmid") || "").trim();
      const quality = (url.searchParams.get("quality") || "128").trim();
      if (!songmid) {
        sendJson(res, 400, { ok: false, error: "songmid_required" });
        return;
      }
      const cdnUrl = await resolveCdnUrl(songmid, quality);
      log("pcm.start", {
        ip,
        songmid,
        cdn: cdnUrl.slice(0, 80),
      });
      await pipeMp3ToPcm(cdnUrl, res, req, { ip, songmid });
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
      await pipeMp3Raw(cdnUrl, res, req, { ip, songmid });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  } catch (error) {
    if (isBenignNetError(error)) {
      warn("request benign end", error.message || error);
      safeEnd(res);
      return;
    }
    const status = error?.statusCode || 500;
    warn("request error", error?.message || error);
    if (!res.headersSent) {
      sendJson(res, status, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } else {
      safeEnd(res);
    }
  }
});

server.on("clientError", (err, socket) => {
  if (!isBenignNetError(err)) warn("clientError", err.message);
  try {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } catch {
    /* ignore */
  }
});

server.listen(PORT, "0.0.0.0", () => {
  log("listening", {
    bind: `0.0.0.0:${PORT}`,
    ffmpeg: ffmpegPath || "MISSING",
    configDir: CONFIG_DIR,
  });
});
