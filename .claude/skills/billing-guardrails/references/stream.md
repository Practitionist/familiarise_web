# Stream (chat and video)

## 1. Plan and limits

The repo records the account as the Maker plan (`docs/infrastructure/00-production-scaling-roadmap.md`, section 4: 2,000 MAU, 333,000 video minutes, $0). VERIFIED 2026-10-17: [getstream.io/pricing](https://getstream.io/pricing/) now lists Chat Build (free) at 1,000 MAU and 100 concurrent connections, Start at $399 a month billed annually ($499 monthly) for 10,000 MAU, with overage of $0.09 per MAU and $0.99 per concurrent connection, plus a $100 monthly free credit for qualifying Maker accounts (fewer than 5 team members and under $10k monthly revenue). [Video pricing](https://getstream.io/video/pricing/) lists Build with 333,000 participant minutes for video calls, pay-as-you-go at $0.30 per 1,000 participant minutes, recording at $3.00 (SD) to $12.00 (Full HD) per 1,000 call minutes and transcription at $8.00 per 1,000 call minutes. The 2,000 MAU in the repo doc conflicts with the 1,000 MAU on the live page; trust the dashboard (unknown).

## 2. What causes surprise bills or outages

- The MAU cliff: past the free limit (2,000 MAU per the repo doc, 1,000 per the live page) the account must move to a paid plan, starting at $499 a month (the repo doc projects +$499). Whether Stream hard-blocks excess connections on Maker or Build until you upgrade is not stated on the pages read (unknown; confirm in the dashboard). The $0.09 per extra MAU overage applies to the Start and Elevate plans, not to the free tier.
- MAU counts `connectUser()` calls with unique ids; `setGuestUser()` mints a new anonymous id per call and inflates MAU.
- Participant minutes multiply by attendees: a 60-minute class with 20 people is 1,200 participant minutes (0.36 percent of 333,000), about INR 32 at $0.30 per 1,000 (INFERRED rate INR 90 per dollar).
- Recording and transcription are billed per call minute on top, and Stream keeps recordings for 14 days unless copied out.
- Chat API calls and channel queries beyond plan are billed; bulk user upserts and unpaged channel queries are the heavy callers.

## 3. Exposure in this repo

- Dev, preview and production share one Stream app (`.claude/skills/stream/SKILL.md`), so QA calls spend production minutes and MAU. The Stream MCP is pinned read-only (`STREAM_MCP_READ_ONLY` in `.mcp.json.example`).
- `auto-complete-appointments` (every 30 min, 25 rows) and `detect-consultant-no-shows` (every 30 min, 10 rows) each make one Stream call-report request per row; the code comment in `netlify/functions/cron-tick.mts` explains the 30-minute cadence as a deliberate halving of Stream call-report volume.
- `reconcile-orphaned-confirmations` and `retry-moderation-enforcement` make Stream round trips per row.
- Recording copy to R2 (`lib/stream/recording-transfer-service.ts`) runs from jobs under `jobs/stream/`; see `references/cloudflare.md` for storage.
- Chunk user upserts and roster adds at 100 with `RATE_LIMIT_DELAY_MS = 10_000`, and page channel queries at 30 (`queryChannelsPaged`), per the stream skill.

## 4. Guardrails to set

Stream dashboard, Usage and Billing: usage alerts at 70 percent of MAU and minutes. Cap concurrent calls per call type where possible. Record only when the plan needs it. When the owner moves to a paid plan, and what the account costs now: value kept in Notion (Familiarise / Finance and Pricing / Vendors & Spend).

## 5. Monitor

Stream MCP: `video_query_aggregate_call_stats`, `video_query_call_stats`, `app_get_rate_limits`. Dashboard: Usage.
