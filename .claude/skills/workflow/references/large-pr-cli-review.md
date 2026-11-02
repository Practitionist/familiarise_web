---
name: large-pr-cli-review
description: Trigger, batch, split, and post full CodeRabbit CLI and SonarQube CLI reviews on large pull requests (>150 files) when GitHub Cloud CodeRabbit skips the PR and GitHub Check Runs truncate SonarCloud annotations at 50 items. Covers the 4-batch × ≤150-file partition within the 5-review/hour rolling quota, synthetic base-tree git plumbing (`GIT_INDEX_FILE` + `git commit-tree`) to avoid false missing-export findings, parallel `/tmp` worktree execution, SonarQube CLI token sourcing, full issue/measure export, and chunked `sonar analyze secrets` scanning (`--diff-filter=d`, ≤80 files/chunk). For triaging, fixing, and resolving the resulting comments, use `references/pr-comment-triage.md`.
---

# Large-PR CLI Review: Batching, Synthetic Base-Tree Splitting, and Full Export

When a pull request touches more than 150 files (for example #2449 at 490 files or #1842 at 626 files), the cloud review integrations hit hard ceilings. This reference covers **how to run and publish complete CodeRabbit CLI and SonarQube CLI reviews across the entire PR diff**. Once the findings are posted, hand off to [pr-comment-triage.md](pr-comment-triage.md) to classify, fix, validate, and resolve them.

---

## 1. Limits and Failure Modes Solved by This Workflow

| Tool / Surface                               | Ceiling or Failure Mode                                                                | Symptom                                                                                                                                                                 | Resolution                                                                                                                                                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CodeRabbit GitHub App**                    | **150 files** max on Essentials plan                                                   | PR comment: `Review skipped: Too many files! This PR contains N files, which is M over the limit of 150.`                                                               | Run `coderabbit review` locally in $\le 4$ batches of $\le 150$ files (`150 × 4 = 600` files).                                                                                                              |
| **CodeRabbit CLI (`v0.9+`)**                 | **300 files** max per invocation; **5 included reviews / rolling 1 hour**              | `Review failed: Too many files!` on full branch; `coderabbit usage` caps at 5 runs/hour.                                                                                | Partition all changed files into $\le 4$ balanced batches ($\le 150$ files each), leaving 1 spare review in the hourly quota.                                                                               |
| **CodeRabbit CLI `--dir <path>`**            | Accepts only **one** directory per run; single dir (`__tests__/`) can exceed 150 files | Running `--dir` across 11 top-level directories would take 11 runs (exceeding the 5/hour cap), and `--dir __tests__` (202 files) cannot split further without sub-runs. | Group multiple directories or split large directories into exact file lists using **Synthetic Base-Tree Plumbing** (`--base-commit`).                                                                       |
| **Partial checkouts / intermediate commits** | Missing cross-file symbols in sandbox                                                  | CodeRabbit reports false-positive "missing export / missing type" findings for symbols added elsewhere in the PR.                                                       | Keep `C_head` equal to `HEAD^{tree}` (100% of PR files present on disk) and construct a synthetic parent `C_base` where only the batch's files are reverted to `dev`.                                       |
| **Sequential CLI execution**                 | ~8–12 min per CodeRabbit CLI batch                                                     | 4 sequential batches take ~40 minutes wall-clock.                                                                                                                       | Mount ephemeral `/tmp/cr-wt-<i>` worktrees (`-B cr-tmp-batch<i>`) so each batch gets an isolated `~/.coderabbit/reviews/<workdir-hash>/<branch-hash>` slot and all 4 run **in parallel** (~8–10 min total). |
| **SonarQube GitHub Check Run**               | **50 annotations** max on GitHub Check Runs API                                        | GitHub only surfaces 50 inline annotations even when SonarQube Cloud found 100+ issues.                                                                                 | Export all issues via `sonar list issues -p Practitionist_familiarise_web --pull-request <PR> --page-size 500 --format json`.                                                                               |
| **SonarQube CLI auth**                       | Keychain unavailable in headless shell                                                 | `❌ Authentication check failed. No saved connection`                                                                                                                   | Source `~/.config/sonarqube-cli/env` (`SONARQUBE_CLI_TOKEN` and `SONARQUBE_CLI_ORG`) before every `sonar` command.                                                                                          |
| **`sonar analyze` / `dependency-risks`**     | Vortex / SCA plan entitlement                                                          | `403 Forbidden (Vortex analysis is not available on this connection)`                                                                                                   | Do not run `sonar analyze --base` or `dependency-risks`; use `sonar list issues`, `sonar qg status`, `sonar api`, and `sonar analyze secrets`.                                                              |
| **`sonar analyze secrets`**                  | No `--base` flag; crashes on deleted files; **30,000 ms timeout**                      | `unknown option '--base'`; `❌ Path not found` on deleted files; `❌ Error: Scan timed out after 30000ms` on 400+ files.                                                | Enumerate live changed files with `git diff --diff-filter=d --name-only dev...HEAD` and scan in chunks of **$\le 80$ files** per invocation.                                                                |

---

## 2. Step-by-Step: CodeRabbit CLI 4-Batch Review (Up to 600 Files)

### Step 2.1 — Check hourly quota and partition changed files

```bash
/usr/local/google/home/kaustavg/.local/bin/coderabbit usage
git diff --name-only dev...HEAD | wc -l
```

Partition all changed files (`git diff --name-only dev...HEAD`) into at most **4 batches of $\le 150$ files**:

- **Batch 1 (single directory, if $\le 150$ files)**: e.g. `lib/` (`145` files). Can run directly in the main worktree via `--dir lib`.
- **Batch 2 (multi-directory production bundle, $\le 150$ files)**: e.g. `app/`, `components/`, `utils/`, `scripts/`, `prisma/`, `schemas/`, `types/`, `hooks/`, `actions/` (`143` files).
- **Batch 3 & Batch 4 (split `__tests__/` halves, $\le 150$ files each)**: e.g. first `101` test files and remaining `101` test files.

### Step 2.2 — Build synthetic `(C_base, C_head)` commit pairs with pure Git plumbing

For any batch `F_batch` that spans multiple directories or slices a single large directory, build a synthetic parent commit `C_base` and child commit `C_head` in the Git object store using a temporary `GIT_INDEX_FILE`. **Never touch the main worktree's `HEAD` or `.git/index`.**

```python
import json, os, subprocess, tempfile

head_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
head_tree = subprocess.check_output(["git", "rev-parse", f"{head_sha}^{{tree}}"], text=True).strip()
dev_sha = subprocess.check_output(["git", "rev-parse", "dev"], text=True).strip()
all_files = subprocess.check_output(["git", "diff", "--name-only", f"dev...{head_sha}"], text=True).strip().splitlines()

batch1_lib = [f for f in all_files if f.startswith("lib/")]
batch2_prod = [f for f in all_files if not f.startswith("lib/") and not f.startswith("__tests__/")]
tests_all = [f for f in all_files if f.startswith("__tests__/")]
mid = len(tests_all) // 2
batch3_tests_a, batch4_tests_b = tests_all[:mid], tests_all[mid:]

batches = {}
for idx, (name, files) in enumerate([
    ("batch2_prod", batch2_prod),
    ("batch3_tests_a", batch3_tests_a),
    ("batch4_tests_b", batch4_tests_b),
], start=2):
    assert len(files) <= 150, f"{name} exceeds 150 files: {len(files)}"
    with tempfile.NamedTemporaryFile(prefix="/tmp/cr_idx_", delete=True) as tmp:
        idx_path = tmp.name
    env = {**os.environ, "GIT_INDEX_FILE": idx_path}
    # Start from the exact HEAD tree so all outside-batch files match HEAD
    subprocess.check_call(["git", "read-tree", head_tree], env=env)
    # Revert only `files` in this batch back to their `dev` state
    existing_in_dev = set(
        subprocess.check_output(["git", "ls-tree", "--name-only", "-r", dev_sha, "--"] + files, text=True).strip().splitlines()
    )
    added_files = [f for f in files if f not in existing_in_dev]
    if added_files:
        subprocess.check_call(["git", "update-index", "--force-remove", "--"] + added_files, env=env)
    if existing_in_dev:
        ls_out = subprocess.check_output(["git", "ls-tree", "-r", dev_sha, "--"] + list(existing_in_dev), text=True)
        subprocess.run(["git", "update-index", "--index-info"], input=ls_out, text=True, check=True, env=env)
    base_tree = subprocess.check_output(["git", "write-tree"], env=env, text=True).strip()
    if os.path.exists(idx_path):
        os.remove(idx_path)
    base_commit = subprocess.check_output(["git", "commit-tree", base_tree, "-p", dev_sha, "-m", f"base for {name}"], text=True).strip()
    head_commit = subprocess.check_output(["git", "commit-tree", head_tree, "-p", base_commit, "-m", f"head for {name}"], text=True).strip()
    diff_files = subprocess.check_output(["git", "diff", "--name-only", f"{base_commit}..{head_commit}"], text=True).strip().splitlines()
    assert sorted(diff_files) == sorted(files)
    batches[idx] = {"name": name, "base": base_commit, "head": head_commit, "count": len(diff_files)}
```

### Step 2.3 — Run all 4 batches in parallel using `/tmp` worktrees and clean up

Mount temporary worktrees in `/tmp/cr-wt-<i>` (outside `~/github/`, never creating standalone `node_modules`) and run all 4 `coderabbit review` processes concurrently:

```bash
# Batch 1 in main worktree (scoped to lib/)
/usr/local/google/home/kaustavg/.local/bin/coderabbit review --base dev --committed --dir lib > /tmp/cr_batch1.txt 2>&1 &

# Batches 2..4 in ephemeral /tmp worktrees
for i in 2 3 4; do
  git worktree add -B "cr-tmp-batch$i" "/tmp/cr-wt-$i" "$HEAD_COMMIT_FOR_I"
  (cd "/tmp/cr-wt-$i" && /usr/local/google/home/kaustavg/.local/bin/coderabbit review --base-commit "$BASE_COMMIT_FOR_I" --committed > "/tmp/cr_batch$i.txt" 2>&1) &
done
wait

# Mandatory cleanup immediately after completion
for i in 2 3 4; do
  git worktree remove --force "/tmp/cr-wt-$i"
  git branch -D "cr-tmp-batch$i"
done
```

---

## 3. Step-by-Step: SonarQube CLI Full Export and Secrets Scan

### Step 3.1 — Export Quality Gate, New-Code Measures, and All Issues (Beyond the 50-Annotation Cap)

Always source `~/.config/sonarqube-cli/env` first, then query SonarQube Cloud for the PR's Quality Gate, component measures, and full issue list (`--page-size 500`):

```bash
source ~/.config/sonarqube-cli/env
SONAR=~/.local/share/sonarqube-cli/bin/sonar
PR=2449

# 1. Quality Gate status
$SONAR qg status -p Practitionist_familiarise_web --pull-request "$PR"

# 2. New-code ratings and metrics
$SONAR api get "/api/measures/component?component=Practitionist_familiarise_web&pullRequest=${PR}&metricKeys=new_reliability_rating,new_security_rating,new_maintainability_rating,new_coverage,new_duplicated_lines_density,new_bugs,new_vulnerabilities,new_code_smells,new_security_hotspots,new_technical_debt" > /tmp/sonar_measures.json

# 3. Complete issue export (up to 500 issues per page; paginate with --page if total > 500)
$SONAR list issues -p Practitionist_familiarise_web --pull-request "$PR" --page-size 500 --format json > /tmp/sonar_issues.json
```

### Step 3.2 — Run local `sonar analyze secrets` in $\le 80$-file chunks excluding deleted files

Filter out deleted files with `--diff-filter=d` and slice the file list into chunks of $\le 80$ files so no invocation hits the 30,000 ms scanner timeout:

```python
import subprocess

files = subprocess.check_output(
    ["git", "diff", "--diff-filter=d", "--name-only", "dev...HEAD"], text=True
).strip().splitlines()

sonar_bin = "/usr/local/google/home/kaustavg/.local/share/sonarqube-cli/bin/sonar"
for i in range(0, len(files), 80):
    chunk = files[i : i + 80]
    res = subprocess.run([sonar_bin, "analyze", "secrets"] + chunk, capture_output=True, text=True, check=True)
    print(f"Chunk {i // 80 + 1} ({len(chunk)} files): {res.stdout.splitlines()[-1]}")
```

---

## 4. Posting Consolidated Review Comments to the PR

Post two structured comments on the PR via `gh pr comment <PR> --body-file ...` (keeping each under GitHub's 65,536-character limit):

1. **CodeRabbit CLI Full-PR Review comment**:
   - Batch summary table showing every batch, directory scope, file count (`N / N` total files), and finding counts (`Major`, `Minor`).
   - Full details for every Major and Minor finding with commit-pinned blob links (`https://github.com/Practitionist/familiarise_web/blob/<HEAD_SHA>/<path>#L<start>-L<end>`) and proposed diff blocks (strip any `/tmp/cr-wt-<i>/` prefix from paths before formatting).
2. **SonarQube CLI Full-PR Review comment**:
   - Quality Gate, new-code measures (`Reliability`, `Security`, `Maintainability`, `Duplication`, `Debt`), and local secrets scan summary table.
   - Rule aggregation table (`Severity | Rule | Count | Representative Message`).
   - Complete issue list sorted by severity: `BLOCKER` / `CRITICAL` and `MAJOR` tables expanded inline, and `MINOR` / `INFO` tables wrapped in a collapsible `<details>` block so the PR timeline stays scannable.
