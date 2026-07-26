import os from "node:os";

/**
 * Prefer a real LAN IPv4 so ESP32 can reach the music proxy.
 * 127.0.0.1 / localhost only works on the PC itself.
 */
export function resolveProxyHost(configured) {
  const raw = String(configured || "").trim();
  if (raw && raw !== "127.0.0.1" && raw.toLowerCase() !== "localhost") {
    return raw;
  }

  const candidates = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const info of list || []) {
      const family = info.family === "IPv4" || info.family === 4;
      if (!family || info.internal) continue;
      const ip = info.address;
      if (!ip || ip.startsWith("169.254.")) continue;
      if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
        candidates.push(ip);
      }
    }
  }

  // Prefer typical home LAN over Windows hosted-network gateway (.1 on 192.168.137)
  const ranked = candidates.sort((a, b) => scoreIp(b) - scoreIp(a));
  return ranked[0] || raw || "127.0.0.1";
}

function scoreIp(ip) {
  if (ip.startsWith("192.168.137.")) return 1;
  if (ip.endsWith(".1")) return 2;
  if (ip.startsWith("192.168.")) return 10;
  if (ip.startsWith("10.")) return 9;
  return 8;
}
