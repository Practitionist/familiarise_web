/** @jest-environment node */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Runs the real script with Docker, Prisma and Jest replaced by stubs.
const SCRIPT = path.join(__dirname, "../../scripts/dev/db-tier-local.sh");
const DOTENV = path.join(__dirname, "../../node_modules/dotenv");
const MARKER = "fw-dbtier-jest-start";

let tmp: string;
let repo: string;
let bin: string;

function stub(file: string, body: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "db-tier-local-"));
  repo = path.join(tmp, "repo");
  bin = path.join(tmp, "bin");
  fs.mkdirSync(path.join(repo, "scripts/dev"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(repo, "scripts/dev/db-tier-local.sh"));
  fs.mkdirSync(path.join(repo, "prisma/sql"), { recursive: true });
  fs.writeFileSync(path.join(repo, "prisma/schema.prisma"), "");
  for (const f of [
    "check-constraints",
    "ledger-triggers",
    "payment-legs-triggers",
    "analytics-views",
  ]) {
    fs.writeFileSync(path.join(repo, `prisma/sql/${f}.sql`), "");
  }
  fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
  fs.symlinkSync(DOTENV, path.join(repo, "node_modules/dotenv"));
  stub(path.join(repo, "node_modules/.bin/prisma"), 'echo "SELECT 1;"');
  stub(
    path.join(repo, "node_modules/.bin/jest"),
    'env | grep "^PROBE" > "$STUB_ENV_OUT"\necho "Tests:       1 passed, 1 total"',
  );
  stub(
    path.join(bin, "docker"),
    [
      'case "$1" in',
      "  port) echo 127.0.0.1:55432 ;;",
      "  run) echo stub-container ;;",
      '  logs) [[ -n "${STUB_LOGS_FAIL:-}" ]] && exit 1',
      '    [[ -z "${STUB_NO_MARKER:-}" ]] && echo "x LOG:  statement: SELECT \'' +
        MARKER +
        "'\"",
      '    echo "x LOG:  execute <unnamed>: SELECT 1" ;;',
      "  exec) [[ \" $* \" == *' -i '* ]] && cat >/dev/null ;;",
      "  *) ;;",
      "esac",
      "exit 0",
    ].join("\n"),
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-q");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function runScript(args: string[], env: Record<string, string> = {}) {
  const log = path.join(tmp, `run-${Date.now()}.log`);
  const envOut = path.join(tmp, "jest-env.txt");
  const r = spawnSync("bash", ["scripts/dev/db-tier-local.sh", ...args, log], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FW_HEAVY_LOCK: path.join(tmp, "heavy.lock"),
      STUB_ENV_OUT: envOut,
      ...env,
    },
  });
  return { ...r, log, envOut };
}

describe("db-tier-local.sh", () => {
  it("blanks every key the dotenv grammar accepts", () => {
    fs.writeFileSync(
      path.join(repo, ".env"),
      'PROBE = sentinel\n  export PROBE2=sentinel\nPROBE_MULTI="line one\nline two"\nPROBE_PLAIN=x\n',
    );
    const r = runScript([]);
    expect(r.status).toBe(0);
    const blanked = fs.readFileSync(r.envOut, "utf8").trim().split("\n");
    expect(blanked.sort()).toEqual(
      ["PROBE=", "PROBE2=", "PROBE_MULTI=", "PROBE_PLAIN="].sort(),
    );
  });

  it("counts the statements after the start marker", () => {
    const r = runScript(["--log-statements"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("statements: 1 in");
  });

  it.each([
    ["docker logs failed", { STUB_LOGS_FAIL: "1" }],
    ["start marker not in the log", { STUB_NO_MARKER: "1" }],
  ])("reports the measurement unavailable when %s", (reason, env) => {
    const r = runScript(["--log-statements"], env);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain(`statements: UNAVAILABLE (${reason})`);
    expect(r.stdout).toContain("jest rc: 0");
    expect(fs.existsSync(`${r.log}.statements`)).toBe(false);
  });
});
