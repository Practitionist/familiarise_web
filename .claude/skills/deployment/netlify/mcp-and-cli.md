# Reading the platform: the Netlify MCP and the CLI

Verified on 2026-09-12. This file records how to get a fact about the live Netlify site from inside a Claude Code session, which tool answers which question, and the traps met while setting the tools up. The other MCP servers this repo uses are summarised at the end because deployment work usually needs two or three of them together.

## The Netlify MCP server

Netlify's official server is `@netlify/mcp` (version 1.15.1 at the time of writing). The block below is what `.mcp.json.example` carries; a teammate copies it into their gitignored `.mcp.json`.

```json
"netlify": {
  "command": "npx",
  "args": ["-y", "@netlify/mcp@1.15.1"]
}
```

Authentication comes from the logged-in Netlify CLI session (`netlify status` shows the user and the linked project); `netlify login` is interactive and must be run by a person. On a machine with no CLI session, set `NETLIFY_PERSONAL_ACCESS_TOKEN` in the block's `env`. Do not ship a placeholder for it: the server returns that variable as the bearer token before it ever consults the CLI session (`getNetlifyAccessToken` in `dist/netlify-mcp.js`), so an unchanged placeholder breaks authentication that would otherwise have worked. The version is pinned because the process inherits write-capable credentials and a mutable `@latest` would let the same config run different code; bump it deliberately.

### The first-connect trap

A cold `npx -y @netlify/mcp@latest` takes about 28 seconds on an M-series laptop, which sits at Claude Code's 30-second MCP connect timeout. When the timeout wins, `npx` is killed mid-extraction and leaves a torn entry under `~/.npm/_npx/<hash>/` — observed as `node_modules/ajv/` containing `dist/` and `lib/` but no `package.json`, so every later start dies with `ERR_MODULE_NOT_FOUND` and looks like a broken dependency rather than a timeout. Warm the cache by hand before the first `/mcp` connect:

```sh
npx -y @netlify/mcp@latest </dev/null
```

If the timeout has already struck, read the log at `~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-netlify/`, take the `<hash>` from the `ERR_MODULE_NOT_FOUND` path, `rm -rf ~/.npm/_npx/<hash>`, and run the warm-up. A warm start takes about two seconds. Piping an `initialize` JSON-RPC line into the server proves it answers without Claude Code in the loop:

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' | npx -y @netlify/mcp@latest
```

### What the nine tools do

The server exposes nine tools, each a selector over a handful of operations; the table below maps them to the questions they answer.

| Tool                                | Operations                                                                                                                                                                                   | Answers                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `netlify-project-services-reader`   | `get-projects` (search by name), `get-project`, `get-forms-for-project`                                                                                                                      | The site ID, plan slug, team ID, current deploy ID, access controls, primary URL                                     |
| `netlify-deploy-services-reader`    | `get-deploy`, `get-deploy-for-site`                                                                                                                                                          | Everything in a deploy record: functions with memory/region/runtime/size, schedules, commit, build time, secret scan |
| `netlify-team-services-reader`      | `get-teams`, `get-team`                                                                                                                                                                      | Team name, plan type name, member count, MFA enforcement, your role                                                  |
| `netlify-user-services-reader`      | `get-user`                                                                                                                                                                                   | Which account the CLI session belongs to                                                                             |
| `netlify-extension-services-reader` | `get-extensions`, `get-full-extension-details`                                                                                                                                               | Installed extensions (the observability extension is one)                                                            |
| `netlify-project-services-updater`  | `manage-env-vars` (get all, upsert, delete, per context and scope), `update-visitor-access-controls`, `update-forms`, `manage-form-submissions`, `update-project-name`, `create-new-project` | Env-var changes; password or SSO gating of previews                                                                  |
| `netlify-deploy-services-updater`   | `deploy-site`                                                                                                                                                                                | A manual deploy from a directory — not used; Git drives every deploy here                                            |
| `netlify-coding-rules`              | one call per primitive: `serverless`, `edge-functions`, `blobs`, `image-cdn`, `forms`, `db`                                                                                                  | Netlify's current authoring guidance, including the `-background` suffix and scheduled-function limits               |

The MCP cannot read function or deploy logs, cannot set memory, timeout, or region, cannot page deploy history, and cannot see billing or capability flags. The `manage-env-vars` read returns values, so prefer the keys-only CLI recipe below when the values do not matter.

## CLI recipes that fill the gaps

The recipes below were each run on 2026-09-12; the CLI is `netlify-cli` 26.x and the repo is linked to the site.

The site ID and current deploy come from the MCP's `get-projects` or from `netlify api getSite --data '{"site_id":"…"}'`. The account's plan and capability flags come only from the API:

```sh
netlify api listAccountsForUser | python3 -c "import sys,json; [print(a['slug'], a['type_slug'], {k:v for k,v in a['capabilities'].items() if 'function' in k or 'credit' in k}) for a in json.load(sys.stdin)]"
```

Deploy history, with the memory and region of each function and the commit it was built from, is the only way to A/B across deploys honestly (`per_page` maxes at 100; page with `page`; history is retained for roughly the last 200 deploys):

```sh
netlify api listSiteDeploys --data '{"site_id":"1a1ad7d0-fda0-4efe-9d58-aa0ce0fd6d5c","per_page":100,"page":1}' \
  | python3 -c "import sys,json; [print(d['created_at'][:16], d['context'], d['functions_region'], d['commit_ref'][:8], [(f['n'], f.get('m')) for f in d.get('available_functions') or []]) for d in json.load(sys.stdin)]"
```

Function logs need the deploy permalink, not the preview or production URL, and `--json` gives one record per line. The Lambda REPORT lines carry the two numbers that matter; the snippet below splits cold from warm invocations:

```sh
netlify logs --source functions --since 24h --json --url https://<deploy-id>--familiarise.netlify.app > /tmp/nf.jsonl
python3 - <<'PY'
import json,re
pts=[]
for l in open('/tmp/nf.jsonl'):
    m=re.search(r'Duration: ([0-9.]+) ms\s+Memory Usage: (\d+) MB', json.loads(l).get('message',''))
    if m: pts.append((float(m.group(1)), int(m.group(2))))
cold=[p for p in pts if p[0]>10000]; warm=[p for p in pts if p[0]<=10000]
print('cold', len(cold), sorted(p[0] for p in cold)[-3:], sorted(p[1] for p in cold)[-3:])
print('warm', len(warm), sorted(p[0] for p in warm)[len(warm)//2] if warm else None)
PY
```

The output is capped at 200 lines per call, so narrow `--since`/`--until` to the window of interest. There is no `Init Duration` line on this handler, so a cold start is identified by its Duration, not by a marker.

Env-var drift between `.env` and production is a keys-only comparison; values never need to enter a transcript:

```sh
netlify env:list --json --context production | python3 -c "import sys,json; print('\n'.join(sorted(json.load(sys.stdin))))" | LC_ALL=C sort -u > /tmp/a
grep -oE '^[A-Z_][A-Z0-9_]*=' .env | tr -d '=' | LC_ALL=C sort -u > /tmp/b
comm -23 /tmp/b /tmp/a   # in .env only
comm -13 /tmp/b /tmp/a   # on Netlify only
```

On 2026-09-12 the `.env`-only keys were `NEXT_PUBLIC_TEST_USERID`, `SEED_PASSWORD`, the four `R2_*` keys for the unimplemented recording bucket (#1314), and a dead `REDIS_URL` that nothing reads (the code and production both use `UPSTASH_REDIS_REST_URL`/`_TOKEN`); the Netlify-only keys were build and observability configuration. `comm` needs the same collation on both inputs, hence `LC_ALL=C`.

## Recipes added in the week of 2026-09-14

Build logs are not reachable through the public API: `GET /api/v1/deploys/{id}/log` and `GET /api/v1/builds/{id}/log` both answer 404 with a valid token, and `getBuild` returns only `error` and `done`. A failed production build has to be read in the UI; the deploy record's `error_message` (`Failed during stage 'building site': Build script returned non-zero exit code: 2`) is all the API gives. A production deploy in state `error` keeps serving the previous deploy, which is how a release that cannot prerender against the live database stays harmless (#1642).

A production rebuild without a commit — needed when a build-time `NEXT_PUBLIC_*` value changes — is one call: `netlify api createSiteBuild --data '{"site_id":"…"}'`; the deploy id comes back as `deploy_id`, and `netlify api getDeploy --data '{"deploy_id":"…"}'` polled every 30 s until `state` is `ready` or `error` is the wait. `netlify api listSiteDeploys` filtered on `context == "production"` gives the currently published commit through `commit_ref`.

Environment values are per context. `netlify env:set NAME value --context production` scopes a value to production only and leaves the other contexts on whatever they had; `netlify env:set NAME value` without `--context` writes every context; `netlify env:unset NAME` removes the name everywhere. `netlify env:list --context <production|deploy-preview|branch-deploy|dev> --json` is the only honest way to see what a given context will receive, and it is how the Novu cutover was verified (production on the Production identifier and key, every other context on Development). Print prefixes and lengths, never values.

`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` need the same per-context split (#1822): every `deploy-preview` and `branch-deploy` build shared production's single Upstash database until the vendor's 500k-command free-tier cap was hit twice in September 2026, once from production traffic alone and once with preview traffic riding along. The fix is the same `netlify env:set --context deploy-preview` / `--context branch-deploy` pattern as the Novu cutover above, pointed at a second Upstash database (its own free tier), leaving `--context production` on the paid database after the owner's pay-as-you-go upgrade.

The burst protocol, now that the probe routes are on `dev`: `scripts/perf/burst-ttfb.sh https://<host>/api/perf/probe-bare 12` and the same for `probe-full`, with unique keys per request, a 15-minute idle gap between bursts, and the JSON body captured (`uptimeAtEntryMs`, `moduleAgeMs`, `idleProbe.maxGapMs`) — the sum of uptime and gap on every new instance is the invariant to compare across hosts. A second driver bursting the same preview during the idle gaps contaminates the "how many of twelve" counts but not the per-instance columns.

## Two GitHub-side traps met on 2026-09-13

`gh pr update-branch --rebase` moved the branch ref but GitHub's pull-request record did not register the new head — no `synchronize` event, no CI run, `mergeStateStatus` stuck — twice in a row during a GitHub incident, and the same call worked normally later. When a PR must re-trigger CI, rebase locally in a throwaway worktree and `git push --force-with-lease`; a real push always registers. If a PR page shows commits or files that belong to other merged PRs, its recorded `base_sha` is stale rather than the branch contaminated: `git diff --stat origin/dev...origin/<branch>` is the truth, and `gh pr edit <n> --base dev` forces GitHub to recompute.

Netlify's build can fail at "preparing repo" with `Host key verification failed` on the SSH clone from GitHub, immediately after a force-push and during GitHub degradation; it hit deploy previews and the `dev` branch deploy alike, about half the time. The public API has no retry method, but the dashboard's endpoint works with the CLI's token and returns 201 with a new deploy: `curl -X POST https://api.netlify.com/api/v1/deploys/<deploy-id>/retry -H "Authorization: Bearer $TOKEN"`, where the token is `users[userId].auth.token` in `~/Library/Preferences/netlify/config.json`. A failed deploy never replaces the live one, so production fails safe.

## The other MCP servers in a deployment session

The table below lists the servers in `.mcp.json.example` that deployment work reaches for, and the one caution each carries.

| Server            | Use in deployment work                                                        | Caution                                                                                    |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `netlify`         | Site, deploy, team, and env-var facts as above                                | No logs, no limits, no billing                                                             |
| `supabase`        | `execute_sql`, `get_logs`, `get_advisors`, `list_tables` against the database | One Supabase project serves dev and prod, so every mutating call is a production operation |
| `sentry`          | `search_issues`, `search_events` to confirm a platform failure reached users  | Read-only by habit; `update_issue` exists                                                  |
| `chrome-devtools` | Driving a deploy preview for logged-in end-to-end checks, Lighthouse runs     | Point it at `deploy-preview-N--familiarise.netlify.app`, never at a local dev server       |
| `sonarqube`       | Quality-gate status for a PR before merge                                     | Runs in Docker with `--pull=always`; the first start downloads the image                   |
| `streamio`        | Chat, video, and moderation state on the Stream app                           | Production app keys; reads are safe, writes are live                                       |

Setup gotchas for the whole file: `.mcp.json` is gitignored because it holds live secrets and only `.mcp.json.example` is tracked; project-scoped stdio servers show `⏸ Pending approval` in `claude mcp list` until the session approves them, which is not a failure; and the `.coderabbit.yaml`-style fail-closed behaviour does not apply here — a malformed `.mcp.json` is reported at startup.

## Sources

- Netlify docs, set up Claude Code: https://docs.netlify.com/build/build-with-ai/agent-setup-guides/set-up-claude-code-for-netlify/
- `@netlify/mcp` README: https://github.com/netlify/netlify-mcp
- `netlify logs` changelog, 2026-05-01: https://www.netlify.com/changelog/2026-05-01-netlify-logs-cli-command/
- PR #1594 (MCP install and the first-connect note)
