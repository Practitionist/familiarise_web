/**
 * Server-derived human label for an auth session ("Chrome on Windows").
 *
 * Stamped onto `Session.deviceLabel` at creation by
 * `databaseHooks.session.create.after` (awaited PK update — deliberately
 * not merged into the insert, so a missing column can never brick
 * sign-in), and re-derived at read time for rows written before this
 * deploy or by direct Prisma writes, which skip BetterAuth hooks.
 *
 * Deliberately dependency-free (~40 lines of regex, no ua-parser-js):
 * the label is coarse by design — browser family + OS family only. The
 * raw `userAgent` string never leaves the server; the device list API
 * returns this label, so no fingerprint lands in devtools or logs.
 *
 * Pure and deterministic — unit-tested in
 * `__tests__/auth/derive-device-label.test.ts`.
 */
export function deriveDeviceLabel(
  userAgent: string | null | undefined,
): string {
  if (!userAgent || typeof userAgent !== "string" || !userAgent.trim()) {
    return "Unknown device";
  }
  const ua = userAgent;

  const os = detectOs(ua);
  const browser = detectBrowser(ua);
  if (browser === "Unknown browser" && os === "Unknown OS") {
    return "Unknown device";
  }
  if (browser === "Unknown browser") return os;
  if (os === "Unknown OS") return browser;
  return `${browser} on ${os}`;
}

function detectOs(ua: string): string {
  // Order matters: iOS/Android tokens also contain "Mac OS X" / "Linux".
  if (/iPhone|iPad|iPod/i.test(ua)) {
    if (/iPad/i.test(ua)) return "iPad";
    return "iPhone";
  }
  if (/Android/i.test(ua)) return "Android";
  if (/Windows NT/i.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  if (/CrOS/i.test(ua)) return "ChromeOS";
  return "Unknown OS";
}

function detectBrowser(ua: string): string {
  // Order matters: Edge/Opera/Brave all embed "Chrome"; check them first.
  // "Edg/" is Chromium Edge, "Edge/" is legacy EdgeHTML.
  if (/Edg\/|Edge\//i.test(ua)) return "Edge";
  if (/OPR\/|Opera/i.test(ua)) return "Opera";
  if (/SamsungBrowser/i.test(ua)) return "Samsung Internet";
  // Firefox on iOS reports "FxiOS", not "Firefox".
  if (/Firefox\/|FxiOS\//i.test(ua)) return "Firefox";
  if (/Chrome\/|CriOS\//i.test(ua)) return "Chrome";
  // Safari last: Chrome-on-iOS also contains "Safari".
  if (/Safari\//i.test(ua)) return "Safari";
  return "Unknown browser";
}
