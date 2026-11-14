/** @jest-environment node */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOOK = path.join(__dirname, "../../.claude/hooks/qa-push-hold.sh");
const HOLD = path.join(__dirname, "../../scripts/dev/qa-hold.sh");
const BRANCH = "feat/qa-held";
const KEY = "feat%2Fqa-held";

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

function run(command: string | null, raw?: string, cwd = repo) {
  const input =
    raw ?? JSON.stringify({ cwd, tool_input: { command, description: "x" } });
  return spawnSync("bash", [HOOK], {
    input,
    encoding: "utf8",
    env: { ...process.env, FW_QA_HOLD_DIR: holds },
  });
}

function qaHold(...args: string[]) {
  return spawnSync("bash", [HOLD, ...args], {
    encoding: "utf8",
    env: { ...process.env, FW_QA_HOLD_DIR: holds },
  });
}

describe("qa-push-hold hook", () => {
  it("allows a push when no hold exists", () => {
    expect(run("git push").status).toBe(0);
  });

  it("blocks a push to a branch held by qa-hold.sh, with the hold's details", () => {
    expect(qaHold("take", BRANCH, "2779", "abc1234").status).toBe(0);
    const r = run("git push -u origin HEAD");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("PR 2779 at head abc1234");
    expect(r.stderr).toContain(
      "wait for the QA run to end, or for the orchestrator to remove the hold file",
    );
  });

  it("allows a push when the hold is on another branch", () => {
    hold("feat%2Fother");
    expect(run("git push").status).toBe(0);
  });

  it("blocks any push from a held checkout, even HEAD:other, by design", () => {
    hold(KEY);
    const r = run("git push origin HEAD:feat/other");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("run it from another worktree");
  });

  it("blocks a chained second push from a held checkout", () => {
    hold(KEY);
    const r = run("git push origin HEAD:feat/other && git push origin");
    expect(r.status).toBe(2);
  });

  it.each([
    ["git push --repo=origin HEAD:feat/x"],
    ["git push origin 'refs/heads/*:refs/heads/*'"],
  ])("blocks %s while any fresh hold exists", (command) => {
    hold("feat%2Fother");
    expect(run(command, undefined, tmp).status).toBe(2);
  });

  it("keeps a branch named with __ apart from one named with /", () => {
    hold(KEY);
    expect(run("git push origin feat__qa-held", undefined, tmp).status).toBe(0);
  });

  it("blocks --all while any fresh hold exists", () => {
    hold("feat%2Fother");
    expect(run("git push origin --all", undefined, tmp).status).toBe(2);
  });

  it("refuses a second hold and keeps the first run's on a wrong release", () => {
    const first = qaHold("take", BRANCH, "2779", "abc1234");
    expect(qaHold("take", BRANCH, "2780", "def5678").status).toBe(1);
    expect(qaHold("release", BRANCH, "2780 def5678 x").status).toBe(1);
    expect(qaHold("release", BRANCH, first.stdout.trim()).status).toBe(0);
    expect(fs.readdirSync(holds)).toEqual([]);
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
