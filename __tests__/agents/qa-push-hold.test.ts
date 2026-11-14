/** @jest-environment node */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOOK = path.join(__dirname, "../../.claude/hooks/qa-push-hold.sh");
const BRANCH = "feat/qa-held";
const KEY = "feat__qa-held";

let tmp: string;
let repo: string;
let holds: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qa-push-hold-"));
  repo = path.join(tmp, "repo");
  holds = path.join(tmp, "holds");
  fs.mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", BRANCH);
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
afterEach(() => fs.rmSync(holds, { recursive: true, force: true }));

function hold(name: string, ageSeconds = 0) {
  fs.mkdirSync(holds, { recursive: true });
  const file = path.join(holds, name);
  fs.writeFileSync(file, "2779 abc1234 2026-11-14T10:00:00Z\n");
  const at = Date.now() / 1000 - ageSeconds;
  fs.utimesSync(file, at, at);
}

function run(command: string | null, raw?: string) {
  const input =
    raw ??
    JSON.stringify({ cwd: repo, tool_input: { command, description: "x" } });
  return spawnSync("bash", [HOOK], {
    input,
    encoding: "utf8",
    env: { ...process.env, FW_QA_HOLD_DIR: holds },
  });
}

describe("qa-push-hold hook", () => {
  it("allows a push when no hold exists", () => {
    expect(run("git push").status).toBe(0);
  });

  it("blocks a push to the held branch with the hold's details", () => {
    hold(KEY);
    const r = run("git push -u origin HEAD");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("PR 2779 at head abc1234");
    expect(r.stderr).toContain(
      "wait for the QA run to end, or for the orchestrator to remove the hold file",
    );
  });

  it("allows a push when the hold is on another branch", () => {
    hold("feat__other");
    expect(run("git push").status).toBe(0);
  });

  it("allows a push past a stale hold and says so", () => {
    hold(KEY, 3 * 3600 + 60);
    const r = run("git push");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("stale");
  });

  it("allows a command that is not a push while a hold exists", () => {
    hold(KEY);
    expect(run("git log --grep push").status).toBe(0);
  });

  it("fails open on malformed input", () => {
    hold(KEY);
    const r = run(null, '{"tool_input": git push');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("could not parse");
  });
});
