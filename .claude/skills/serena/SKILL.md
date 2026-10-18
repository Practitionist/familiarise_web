---
name: serena
description: Use the Serena MCP (a language-server-backed code index) safely on this repo — when its type-aware references beat ripgrep and when they don't, the 2.0.0 minimum version and why 1.7.0 returned silently wrong answers, how to tell a real empty result from a crashed TypeScript server, the tools worth calling and the ones the built-in tools already cover, what `rename_symbol` does not update (jest.mock strings, dynamic imports, source-text tests, docs paths), the setup in the gitignored `.mcp.json`, why the project-trust setting should stay narrow, and why Serena's reminder and auto-approve hooks stay off. Use when the user says "Serena", "find references", "who calls this", "is this unused", "dead code", "safe to delete", "rename this symbol", "which definition does this import", or is planning a reorganisation, a helper merge, or a deletion sweep.
---

# Serena

Serena is an MCP server that runs a real TypeScript language server over the repo and exposes it as tools. Its value here is one thing that text search cannot do: it resolves each reference to the specific definition it binds to. When three files each export a `formatDateTime`, ripgrep finds every mention of the name, but Serena tells you which of the three each caller actually imports, and which function each call sits inside.

Everything else it offers (reading files, regex search, line edits) the built-in tools already do at least as well. `AGENTS.md` and this skill take precedence over Serena's own instruction manual, which tells the agent to treat the built-in Read and Edit tools as forbidden; ignore that.

## Version and setup

Serena **2.0.0 or later** is required. Version 1.7.0 crashed its TypeScript server on the first repo-wide query on an 8 GB machine (most likely out of memory, given the 18 MB generated Prisma client types) and then answered every reference query with an empty `{}` in about 0.26 s, with no error. On this repo that looks exactly like "no callers", which is the answer that leads to deleting live code. Version 2.0.0 (released 2026-10-13) handled the same queries without crashing. If its TypeScript server does crash, every later cross-file query raises `TypeScriptServerCrashedError` instead of returning an empty result, and it no longer drops callers that share the target's name.

Serena is installed as a uv tool and registered per developer in `.mcp.json`, which is gitignored, so each machine adds it by hand:

```json
"serena": {
  "command": "serena",
  "args": ["start-mcp-server", "--context", "claude-code", "--project-from-cwd"]
}
```

```bash
uv tool install serena-agent      # first time
uv tool upgrade serena-agent      # later; restart Claude Code afterwards
serena --version                  # must print 2.0.0 or later
```

- `--context claude-code` hides the Serena tools that duplicate Claude Code's own.
- `--project-from-cwd` picks the project from the folder Claude Code starts in, so the same entry works in every git worktree.
- The tracked project config is `.serena/project.yml`. It lists `typescript` under `language_servers`. Serena rewrites this file to its current schema when a newer version first starts: it renames `languages` to `language_servers` and `additional_workspace_folders` to `ls_additional_workspace_folders`, and adds new keys with default values. Commit that rewrite as it is; it does not lose any setting.
- An upgrade only takes effect after Claude Code restarts, because the running MCP server keeps the old code in memory.
- If `/mcp` shows Serena failing to connect at startup, raise the client timeout with `export MCP_TIMEOUT=60000` in the shell profile. On this repo the server itself starts in about 2 s.
- Each worktree is registered as its own project in the global config (`~/.serena/serena_config.yml`). After removing a worktree, run `serena project remove <path>` so the registry does not keep stale entries.

## Trusted projects

Serena 2.0.0 treats each project as trusted or untrusted, using `trusted_project_path_patterns` in the global config. For an **untrusted** project, Serena uses its own pinned TypeScript (5.9.3) instead of the project's `tsserver.js`, and it ignores symlinks inside the project. A **trusted** project gets the project's own `tsserver.js` and followed symlinks, which means opening a trusted repo runs code from that repo.

- This repo needs no trust. It pins `typescript` 5.9.3, which is the same version Serena bundles.
- Do not trust everything with `'**'`. That pattern runs the `tsserver.js` of every repo Serena opens, including freshly cloned ones. If trust is ever needed, list this checkout's root path exactly. A pattern ending in `/**` matches only paths _below_ a root, so it never matches the root itself.

## Hooks and the system-prompt override: skip them

Serena's documentation recommends optional Claude Code hooks (`serena-hooks`) and a system-prompt override. On this repo, leave them off:

- **`serena-hooks remind`** (a PreToolUse hook) nudges the agent toward Serena after several `grep` or file reads in a row. That fights this skill's rule to start with `rg`, which is about 10 times faster than a warm Serena query (and over 300 times faster than the first one) and also sees strings, comments, docs and configs.
- **`serena-hooks auto-approve`** approves every `mcp__serena__*` call in `acceptEdits` or `auto` permission mode, including `rename_symbol` and `replace_symbol_body`. Those edit files across the repo and should stay visible.
- **`serena-hooks activate`** (SessionStart) only prompts the agent to activate the project, which `--project-from-cwd` already does.
- **`serena prompts print-cc-system-prompt-override`** produces a system prompt that ranks Serena above the built-in tools. It conflicts with `AGENTS.md` taking precedence.

## Measured behaviour on this repo (2.0.0, 2026-10-18)

| Operation                                              | Time           |
| ------------------------------------------------------ | -------------- |
| First reference query of a session (loads the project) | about 11 s     |
| Later `find_referencing_symbols` calls                 | 0.2–0.4 s each |
| Repo-wide `find_symbol` with no `relative_path`        | about 9 s      |
| `rg` over the same tree                                | about 0.03 s   |

The answers matched hand-verified ones. `deliver` from `lib/email/deliver.ts` has 11 importing files. `formatSlotsForAPI` in `lib/scheduling/calendarUtils.ts` is used only by a test. The `formatDateTime` in `components/collaborators/format.ts` has 8 call sites in `ScheduleSummaries.tsx`. Serena also found that the `formatDateTime` in `components/dashboard/shared/requests/InboxRow.tsx` has no importers but is used inside its own file, which an importer search misses.

## When to use which tool

| Question                                         | Tool                                                                                | Why                                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| "Where is X mentioned?" or a first look          | `rg`                                                                                | Instant, sees comments, strings, docs and configs                                                                         |
| "Which of the duplicate X's does this file use?" | Serena `find_referencing_symbols` on each definition                                | Resolves imports, aliases and re-exports                                                                                  |
| "Is this export dead?"                           | `npx knip` first, then Serena on each candidate, then `rg` for the name as a string | knip covers the whole repo in about 10 s; Serena confirms per symbol; `rg` catches string and dynamic uses that both miss |
| "What does this file define?"                    | Serena `get_symbols_overview`                                                       | A compact symbol list without reading the whole file                                                                      |
| "Rename this identifier everywhere"              | Serena `rename_symbol`, then the checks in "What Serena cannot see"                 | Type-aware rename across importers                                                                                        |
| "Move or rename a file"                          | Not Serena                                                                          | It has no file-move tool on the LSP backend; use `git mv` plus a codemod, then a cold `npx tsc --noEmit`                  |

## Trusting an empty result

On 2.0.0, a crashed TypeScript server makes every cross-file query raise `TypeScriptServerCrashedError`, so a plain `{}` is a real answer from a live server. It is still not proof that code is unused, because the language server cannot see string-based uses. Before deleting on the strength of one:

1. If any Serena call has raised `TypeScriptServerCrashedError` this session, or the newest log under `~/.serena/logs/<date>/` shows `SIGABRT`, `Exited` or `Crashed`, restart Claude Code and rerun the query.
2. Search for the name with `rg -w`, including tests, `lib/cron/cleanup-registry.ts`, `.github/workflows/` and `scripts/`.
3. Delete only when all three agree: knip, Serena and `rg`.

## What Serena cannot see

These all hold module paths or names as plain strings, so neither the language server nor `rename_symbol` updates them:

- **Dynamic imports in the cleanup registry.** `lib/cron/cleanup-registry.ts` loads about 59 job modules with `import("@/…")` inside lazy functions. A job body can look unreferenced while the scheduler still calls it.
- **`jest.mock("@/…")` paths.** About 124 distinct module paths are mocked across `__tests__/`. A stale path is not a type error; it fails only when that suite runs.
- **Source-text tests.** Many suites `readFileSync` a source file by path and assert on its text. Moving or renaming the file breaks them.
- **Docs and skills.** Backticked paths in `docs/` and `.claude/skills/` are checked by `scripts/ci/check-docs-drift.ts`; run it after any rename.
- **Configs that name paths.** These include `jest.config.ts` (the `redis-edge` mock mapping), `tailwind.config.ts` (content globs), `components.json`, `next.config.mjs` (file tracing), `knip.json` and `.coderabbit.yaml`.

## Working rules

- **Scope queries to save time and memory.** Pass `relative_path` to `find_symbol` whenever you know the file or folder; a repo-wide search walks every file.
- **Use Serena for reading, and only for single-symbol edits.** For edits, the built-in Edit tool and `rg` remain the default. Use `replace_symbol_body` only when replacing a whole function is clearer than a line edit.
- **Do not trust the repo's Serena memories.** The files in `.serena/memories/` were last updated on 2026-03-31 and describe a stack the repo no longer has (they mention Stripe). `AGENTS.md`, the domain skills and the code are the source of truth.
- **Run it from the main checkout or a worktree with `node_modules` symlinked.** The language server resolves types through `node_modules`. Without it, every import is unresolved and references come back incomplete.
- **Subagents share the same Serena server.** A crash during one agent's query empties every other agent's results for the rest of the session. Give research agents rg and knip, and keep Serena for the orchestrator's targeted checks.

## Deprecated & Superseded Approaches

- **Serena 1.7.0.** It returned `{}` for every reference query after its TypeScript server crashed, with no error, and it has no setting to raise the server's memory limit. Upgrade to 2.0.0 or later; never treat a 1.7.0 empty result as evidence.
- **`uvx --from git+https://github.com/oraios/serena`** as the launch command. It downloads and runs the latest unreleased source on every start, which is slower and changes behaviour without notice. The installed uv tool is pinned until you upgrade it.
- **Trusting every project (`trusted_project_path_patterns: ['**']`).** It makes Serena run the `tsserver.js` of any repo it opens. This repo needs no trust, because its TypeScript version matches the one Serena bundles.
