---
name: workspace-refresh
description: Refresh a git workspace — find which local branches, remote branches and worktrees are already merged and safe to delete, which hold unmerged or unpushed work worth keeping, and which projects are unfinished — then clean up only what the user approves. Works for any repository, including ones that squash-merge, where `git branch --merged` is blind. Use when the user says "refresh the workspace", "clean up branches", "prune merged branches", "which worktrees are stale", "what have I left unfinished", "what's only on my machine", or asks to sync local with the remote.
---

# Workspace refresh

A workspace refresh answers four questions in order: what is merged and safe to delete, what is not merged and must be kept, what exists only on this machine, and what is unfinished. It then deletes only what the user approved. The survey is read-only; nothing is deleted before the user answers.

## Principles

Merge status comes from the pull request, not from git ancestry. Squash and rebase merges rewrite commits, so a merged branch's commits never become ancestors of the default branch, and `git branch --merged` and `git cherry` both report fully merged work as unmerged. Ask the forge (`gh pr list --state all`) which PR used each branch as its head, and treat that as the evidence.

A merged PR proves the reviewed commits shipped, not that the branch tip did. A branch can carry commits made after the merge, so compare the tip's commit time with the PR's `mergedAt`, and compare the tip with the PR's `headRefOid` when that object exists locally. Only branches with nothing after the merge are safe.

The default branch (`main`, `dev`, `prod` and any other long-lived branch the project protects) is never a cleanup candidate. Neither is the branch you are standing on, nor a worktree with uncommitted changes.

A deletion that only touches local refs is cheap to undo while the objects remain. A remote deletion changes shared state and is outward-facing, so it gets its own explicit approval even when the local deletions are approved.

## Procedure

1. **Sync.** `git fetch --prune origin`. A stale remote-tracking ref makes every later comparison wrong, and pruning turns remotes deleted on the forge into `[gone]` upstreams.
2. **Inventory.** List worktrees (`git worktree list`), local branches with upstream and tracking state (`git for-each-ref refs/heads --format='%(refname:short)|%(upstream:short)|%(upstream:track)|%(committerdate:short)'`), remote branches, and every PR with its state, base and head branch (`gh pr list --state all --limit 300 --json number,headRefName,state,mergedAt,baseRefName`). Note the working-tree state of the main checkout and of every worktree.
3. **Classify** each branch and worktree with the table below.
4. **Verify the risky ones.** For anything you plan to call safe, check for commits after the PR merged. For anything with no PR, count what it holds that the default branch lacks (`git rev-list --count origin/<default>..<branch>`) and read the newest commit subjects to see what the work is.
5. **Present** the result as three groups: safe to delete, keep, and needs a decision. Then ask what to do, using the ask tool, with the safe groups pre-selected as the recommended options and each destructive option saying exactly what it removes.
6. **Execute** in the order below, only for approved items.
7. **Report** what was removed, what was kept and why, and where the recovery SHAs are.
8. **Roundup** the unfinished work: open PRs (marking drafts and how long since the last update), local-only branches, closed-unmerged PRs, and any overlap between open PRs. Offer to push local-only work to the remote as a draft PR.

## Classification

| State                                    | Evidence                                   | Action                                                                                                   |
| ---------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Merged, no post-merge commits            | PR `MERGED`, tip older than `mergedAt`     | Safe to delete, local and remote                                                                         |
| Merged, has post-merge commits           | PR `MERGED`, commits newer than `mergedAt` | Keep; the new commits never shipped                                                                      |
| Closed without merging                   | PR `CLOSED`, `mergedAt` null               | Needs a decision; the work may be superseded, check the default branch for the feature before discarding |
| Open PR                                  | PR `OPEN`, including drafts                | Keep; list in the roundup                                                                                |
| No PR, commits not on the default branch | `rev-list --count` above zero              | Keep, or back up first; this is the work most likely to be lost                                          |
| No PR, nothing unique                    | zero unique commits                        | Safe to delete                                                                                           |
| `[gone]` upstream                        | remote branch deleted on the forge         | Not a status by itself; classify by PR state. With no merged PR, the local branch is the only copy       |
| Worktree on a safe branch, clean         | `git -C <path> status --short` empty       | Remove the worktree, then the branch                                                                     |
| Worktree dirty or on a kept branch       | any output, or kept branch                 | Keep and report                                                                                          |
| Bot branches (dependency updaters)       | head branch of an open bot PR              | Keep; the bot owns them                                                                                  |

A branch that is a merged PR's base rather than its head (a stacked PR merged into another feature branch) is classified by its own PR, and its parent branch must be checked too.

## Execution order

1. Record every tip SHA about to be deleted, local and remote, in a file outside the repository, for example `/tmp/deleted-branch-shas.txt`. This is the recovery list.
2. Switch to the default branch if the current branch is a deletion target, then `git merge --ff-only origin/<default>` to bring it up to date. Uncommitted changes carry over; stop if the fast-forward would touch a file they modify.
3. `git worktree remove <path>` for approved worktrees. Do not pass `--force` without looking at what it would discard.
4. `git branch -D` for approved local branches. Lowercase `-d` refuses squash-merged branches because git cannot see them as merged, which is expected and not a reason to skip them.
5. `git push origin --delete <branch> ...` for approved remote branches, last.

## Recovering and preserving

Unpushed commits live only in the local object database, and a branch is a pointer to them. Deleting the pointer leaves the objects until garbage collection, so `git branch <name> <sha>` from the recovery list restores a branch, and `git reflog` also lists recent tips. A deleted remote branch with a PR can be restored from the PR page. A branch with no PR and no local copy can be recreated only from a SHA whose objects are still present locally.

To preserve local-only work, push the branch (`git push -u origin <branch>`) and open a draft PR. When the branch is old and holds squash-merged commits, the PR diff will look huge and conflict; say so in the PR body, name the one or few commits that are the real change, and list what remains before it can merge. Offer to cherry-pick those commits onto the current default branch for a readable diff rather than rewriting the branch unasked.

## Pitfalls

- Never run `git stash` to get a clean tree for the survey: the stash stack is shared by every worktree of the repository, so a sibling worktree's pop can take the wrong entry.
- `git merge-tree` reporting that a branch "adds content" is not proof it is unmerged, since the default branch may have changed the same files since a squash merge. Use PR state and post-merge commits.
- Do not run `git gc`, `git reflog expire` or `git prune` as part of a refresh; they destroy the safety net the recovery list relies on.
- Delete by explicit branch name; never pipe a computed list straight into `git branch -D` without showing it to the user first.
- A project's own contributing rules (branch protection, who may delete remote branches, what to do with worktree `node_modules`) override this skill.
