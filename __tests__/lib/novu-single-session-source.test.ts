import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const DIRS = ["app", "components", "hooks", "providers"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("Novu client sessions", () => {
  it("only NotificationInbox opens a session, and it waits for the hash", () => {
    const openers = DIRS.flatMap((d) => sourceFiles(path.join(ROOT, d))).filter(
      (f) => /from "@novu\/(nextjs|react)"/.test(readFileSync(f, "utf8")),
    );
    expect(openers.map((f) => path.relative(ROOT, f))).toEqual([
      "components/notifications/NotificationInbox.tsx",
    ]);
    const inbox = readFileSync(openers[0], "utf8");
    expect(inbox).toContain("resolveInboxAuth");
    expect(inbox).toContain("!authReady");
  });
});
