# Cloudflare

## 1. Plan and limits

This repo uses Cloudflare for two things: R2 object storage for call recordings (`lib/storage/r2-client.ts`, `lib/stream/recording-storage.ts`, `lib/stream/recording-transfer-service.ts`) and, in the failback design, neutral authoritative DNS (`docs/deployment/emergency-failback-runbook.md`). Production DNS is currently Netlify DNS (`docs/deployment/netlify.md`), and no Workers, D1, KV or Images are deployed; Workers hosting was eliminated (`docs/deployment/multi-platform-evaluation.md`). The Cloudflare plan is not recorded in the repo (unknown).

VERIFIED 2026-10-17 from [R2 pricing](https://developers.cloudflare.com/r2/pricing/): free tier each month is 10 GB-month storage, 1 million Class A and 10 million Class B operations on Standard storage; beyond that Standard storage is $0.015 per GB-month, Class A $4.50 per million, Class B $0.36 per million; egress is free; DeleteObject and AbortMultipartUpload are free; Infrequent Access has a 30-day minimum and a $0.01 per GB retrieval fee. VERIFIED from [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/): Free is 100,000 requests a day at 10 ms CPU; Paid is $5 a month with 10 million requests and 30 million CPU ms, then $0.30 per million requests; KV free is 100,000 reads and 1,000 writes a day; D1 free is 5 million rows read and 100,000 rows written a day.

## 2. What causes surprise bills

- Class A operations (PUT, LIST, multipart parts) cost 12.5 times a Class B read. A multipart upload of a large file issues one Class A per part plus the create and complete calls.
- Storage is the only meter that grows without activity: recordings kept forever accumulate GB-months.
- Infrequent Access charges a retrieval fee and 30-day minimum, so moving short-lived files there costs more.
- Workers CPU and D1 row reads can run away on a bad query, but nothing here uses them.
- Image resizing and Images are separately metered; unused here.

## 3. Exposure in this repo

`lib/storage/r2-client.ts` uploads recordings in 10 MB parts (`R2_MULTIPART_PART_SIZE`), so a 1 GB recording is about 100 part uploads, a negligible Class A count against the 1 million free. The real exposure is storage growth from the retention policy in `docs/decisions/2026-10-09-recording-storage-retention-visibility.md`; with the free 10 GB-month covering about ten 1 GB recordings, expect to pay storage from the first busy month. At $0.015 per GB-month, 1 TB is $15 (about INR 1,350 at INR 90 to the dollar; INFERRED rate). Egress is free, so the replay marketplace does not add a bandwidth line.

## 4. Guardrails to set

Dashboard, R2, bucket settings: add a lifecycle rule to delete or transition old recordings to match the retention decision, and enable billing notifications (Account, Notifications, Billing: usage-based billing alert). Keep the token scoped to the one bucket. Cloudflare DNS has no per-query bill, but never delete the custom domains on the standby (`docs/deployment/README.md`).

## 5. Monitor

Cloudflare MCP (`mcp__cloudflare__execute`) with the GraphQL analytics API for R2 operations by class, or the dashboard R2 Metrics tab. Bucket size: `aws s3 ls --summarize --recursive s3://$R2_BUCKET --endpoint-url $R2_S3_ENDPOINT`.
