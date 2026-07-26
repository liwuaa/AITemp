import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG_DIR = path.join(ROOT, "config");
const LOG_DIR = path.join(ROOT, "logs");
const USER_INFO_PATH = path.join(CONFIG_DIR, "user-info.json");
const QR_PNG_PATH = path.join(LOG_DIR, "qq-login-qr.png");
const QR_HTML_PATH = path.join(LOG_DIR, "qq-login-qr.html");

process.env.QQ_MUSIC_API_CONFIG_DIR = CONFIG_DIR;
process.env.USE_GLOBAL_COOKIE = "true";

fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const openPath = (targetPath) => {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", targetPath], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [targetPath], { detached: true, stdio: "ignore" }).unref();
};

const readSavedAuth = () => {
  try {
    const raw = JSON.parse(fs.readFileSync(USER_INFO_PATH, "utf-8"));
    const cookie = typeof raw.cookie === "string" ? raw.cookie.trim() : "";
    const loginUin =
      (typeof raw.loginUin === "string" && raw.loginUin) ||
      cookie.match(/(?:^|;\s*)uin=([^;]+)/)?.[1] ||
      "";
    return { cookie, loginUin };
  } catch {
    return { cookie: "", loginUin: "" };
  }
};

const saveAuth = (cookie) => {
  const loginUin = cookie.match(/(?:^|;\s*)uin=([^;]+)/)?.[1] || "";
  fs.writeFileSync(
    USER_INFO_PATH,
    `${JSON.stringify({ loginUin, cookie }, null, 2)}\n`,
    "utf-8"
  );
  return loginUin;
};

const unwrapBody = (result) => {
  if (!result || typeof result !== "object") return {};
  if (result.body && typeof result.body === "object") return result.body;
  return result;
};

const isCookieValid = async (getMusicPlay, cookie) => {
  if (!cookie) return false;
  if (!/(?:^|;\s*)uin=/.test(cookie)) return false;
  if (!/(?:^|;\s*)(qqmusic_key|qm_keyst)=/.test(cookie)) return false;
  try {
    const result = await getMusicPlay({
      songmid: "003rJSwm3TechU",
      quality: "128",
      cookie,
    });
    const body = unwrapBody(result);
    const text = JSON.stringify(body);
    if (/sip|purl|vkey|playUrl|music\.tc\.qq\.com/i.test(text)) return true;
    if (body?.error || body?.response?.code > 0) return false;
    return Boolean(body && Object.keys(body).length);
  } catch {
    return false;
  }
};

const writeQrFiles = (imgDataUrl) => {
  const match = String(imgDataUrl || "").match(/^data:image\/\w+;base64,(.+)$/);
  if (!match) throw new Error("QR response missing base64 image");
  fs.writeFileSync(QR_PNG_PATH, Buffer.from(match[1], "base64"));
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>QQ Music Login QR</title>
  <style>
    body { font-family: sans-serif; text-align: center; padding: 32px; background: #111; color: #eee; }
    img { width: 280px; height: 280px; background: #fff; padding: 12px; border-radius: 8px; }
    p { margin-top: 16px; line-height: 1.6; }
  </style>
</head>
<body>
  <h1>QQ Music Scan Login</h1>
  <img src="${imgDataUrl}" alt="QQ Login QR" />
  <p>请使用手机 QQ / QQ 音乐扫描二维码登录。<br/>登录成功后可关闭本页面。</p>
</body>
</html>`;
  fs.writeFileSync(QR_HTML_PATH, html, "utf-8");
};

const loginWithQr = async (getQQLoginQr, checkQQLoginQr) => {
  const maxRounds = 3;
  for (let round = 1; round <= maxRounds; round += 1) {
    console.log(`[LOGIN] Fetching QR code (round ${round}/${maxRounds})...`);
    const qrResult = await getQQLoginQr();
    const qrBody = unwrapBody(qrResult);
    const img = qrBody.img;
    const qrsig = qrBody.qrsig;
    const ptqrtoken = qrBody.ptqrtoken;
    if (!img || !qrsig || !ptqrtoken) {
      throw new Error(`Invalid QR response: ${JSON.stringify(qrBody).slice(0, 300)}`);
    }

    writeQrFiles(img);
    console.log(`[LOGIN] QR saved: ${QR_PNG_PATH}`);
    console.log("[LOGIN] Opening QR page, please scan with QQ / QQ Music...");
    openPath(QR_HTML_PATH);

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const checkResult = await checkQQLoginQr({ ptqrtoken, qrsig });
      const checkBody = unwrapBody(checkResult);
      if (checkBody.isOk && checkBody.session?.cookie) {
        const uin = saveAuth(checkBody.session.cookie);
        console.log(`[LOGIN] Success. uin=${uin || "(unknown)"}`);
        console.log(`[LOGIN] Cookie saved to ${USER_INFO_PATH}`);
        return true;
      }
      if (checkBody.refresh) {
        console.log("[LOGIN] QR expired, refreshing...");
        break;
      }
      if (checkBody.message) {
        process.stdout.write(`\r[LOGIN] Waiting... ${checkBody.message}          `);
      }
    }
    console.log("");
  }
  throw new Error("QR login timed out. Please rerun start.bat");
};

const main = async () => {
  if (process.env.SKIP_QQ_LOGIN === "1") {
    console.log("[LOGIN] SKIP_QQ_LOGIN=1, skip QR login");
    return;
  }

  const { getQQLoginQr, checkQQLoginQr, getMusicPlay } = await import(
    "@sansenjian/qq-music-api/sdk"
  );

  // Optional bootstrap from .env QQMUSIC_COOKIE
  const envCookie = (process.env.QQMUSIC_COOKIE || "").trim();
  if (envCookie && !readSavedAuth().cookie) {
    const uin = saveAuth(envCookie);
    console.log(`[LOGIN] Imported QQMUSIC_COOKIE from .env, uin=${uin || "(unknown)"}`);
  }

  const saved = readSavedAuth();
  if (saved.cookie) {
    console.log(`[LOGIN] Found saved cookie for uin=${saved.loginUin || "(unknown)"}, validating...`);
    const ok = await isCookieValid(getMusicPlay, saved.cookie);
    if (ok) {
      console.log("[LOGIN] Cookie is valid, skip QR login");
      return;
    }
    console.log("[LOGIN] Cookie invalid/expired, need QR login");
  } else {
    console.log("[LOGIN] No cookie found, need QR login");
  }

  await loginWithQr(getQQLoginQr, checkQQLoginQr);
};

main().catch((error) => {
  console.error(`[LOGIN] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});