import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} configDir
 */
export function readUserAuth(configDir) {
  const infoPath = path.join(configDir, "user-info.json");
  try {
    const raw = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
    const cookie = typeof raw.cookie === "string" ? raw.cookie.trim() : "";
    const loginUin =
      (typeof raw.loginUin === "string" && raw.loginUin) ||
      cookie.match(/(?:^|;\s*)uin=([^;]+)/)?.[1] ||
      "";
    return {
      cookie,
      loginUin,
      hasCookie: Boolean(cookie),
      infoPath,
    };
  } catch {
    return {
      cookie: "",
      loginUin: "",
      hasCookie: false,
      infoPath,
    };
  }
}

export function cookieKeyNames(cookie) {
  if (!cookie) return [];
  return cookie
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.split("=")[0]?.trim())
    .filter(Boolean);
}
