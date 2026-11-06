# ADR: One Stream app for every environment until launch

- **Status:** accepted by the owner on 2026-11-06.
- **Supersedes:** the 2026-10-24 decision, in the Stream productionization train, to move dev and previews to a separate "Familiarise-dev" Stream app before launch.
- **Related:** #2376 ("fix(stream): refuse the production Stream key outside production"), now parked as a draft; #2525 (member emails stored at Stream).

## Context

Production, deploy previews, the `dev` branch deploy and every laptop use the same Stream app (`app_id` 1366319, key `k4n5crxtstrx`). #2376 adds a guard that refuses that key anywhere except production. It cannot merge until a second Stream app exists and every non-production Netlify context carries that app's four keys. Until then, the guard would switch chat and video off on every preview and on `dev.familiarisenow.com`.

The platform is pre-MVP. The shared Postgres database holds only seeded and QA data, so every Stream user and call belongs to a mock account, and a preview that mints a token or opens a call touches nothing real.

## Decision

Keep the single Stream app for every environment until launch. #2376 stays a draft and is not merged. Do not create the Familiarise-dev app yet.

The risks the split was meant to remove are accepted for now, because the data is mock:

- A preview or a laptop can mint tokens for any user in the shared app and create billable calls and recordings.
- A `revoke_tokens_issued_before` run during testing would sign everyone out.
- The streamio MCP points at the same app, so it stays read-only (`STREAM_MCP_READ_ONLY: "true"`).

## When this changes

At launch, before real users sign up, take these steps in order. They are listed in the go-live skill.

1. Create the Familiarise-dev app in the Stream dashboard.
2. Set `STREAM_API_KEY`, `STREAM_API_SECRET`, `NEXT_PUBLIC_STREAM_API_KEY` and `STREAM_WEBHOOK_SECRET` to the dev app's values in the Netlify deploy-preview and branch-deploy contexts.
3. Put the same four dev-app values in every local `.env`. After step 5, a laptop that still holds the production key gets no chat or video, because the guard refuses that key outside production.
4. Configure the dev app with `npx tsx scripts/stream/ensure.ts --apply --routes-are-deployed`, with the dev keys in the shell.
5. Refresh #2376 onto `dev`, mark it ready, and merge it.
6. Rebuild previews, because `NEXT_PUBLIC_STREAM_API_KEY` is inlined at build.

## Deprecated & Superseded Approaches

- **Split the Stream app before launch (2026-10-24).** It was deferred, not dropped. The split protects real users, and there are none before launch, so the four extra secrets and the second control plane would cost upkeep with no benefit yet.
