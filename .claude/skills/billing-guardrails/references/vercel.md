# Vercel

## 1. Plan and limits

This repo is not deployed on Vercel today; production is Netlify and the evaluated alternative is `Vercel Pro bom1` (`docs/deployment/multi-platform-evaluation.md`). No Vercel config file exists. Read this before any cutover. VERIFIED 2026-10-17 from [Vercel pricing](https://vercel.com/docs/pricing): Hobby includes 4 hours Active CPU, 360 GB-hours provisioned memory and 1 million invocations; Pro gets a monthly usage credit and then bills on demand; image transformations include 5K on Hobby then $0.05 to $0.0812 per 1K, cache writes $4.00 to $6.40 per million; paid builds cost $0.0035 per CPU minute (Basic machine $0.007 a minute); extra Pro seats are $20 a month.

## 2. What causes surprise bills

- Fluid compute bills Active CPU and provisioned memory, so a slow database round trip keeps memory billing while CPU idles; long functions cost more.
- Image optimization transformations and cache writes grow with unique image URLs and widths.
- ISR writes and reads bill per operation; frequent `revalidate` plus on-demand purges raise writes.
- Preview deployments build on every push and each build bills CPU minutes.
- Add-ons are fixed monthly lines (Preview Deployment Suffix $100, Password Protection $20 per project, Static IPs $100 per project).

## 3. Exposure in this repo

The dual-boot rules (`docs/deployment/README.md`) keep the code runnable on Vercel: edge middleware reads `x-vercel-forwarded-for` only when `process.env.VERCEL === "1"` and stamps the result for Node code, and `sharp` is excluded only on Netlify or Vercel in `next.config.mjs`. The 4.5 MB request body cap is why uploads over 4 MB use Supabase presigned URLs. `next.config.mjs` `images.formats` enables AVIF and WebP, which doubles transformation variants if image optimization is billed per transformation.

## 4. Guardrails to set

Team settings, Billing, Spend Management: set an on-demand budget with the pause-projects action and email alerts. Set the Pro plan's included credit as the alert baseline. Disable preview builds for bot branches with an Ignored Build Step.

## 5. Monitor

Vercel MCP: `list_billing_charges` and `list_contract_commitments`; `get_rolling_release_billing_status` for rolling releases. CLI fallback: `vercel usage` is not verified here (unknown); use Dashboard, Usage.
