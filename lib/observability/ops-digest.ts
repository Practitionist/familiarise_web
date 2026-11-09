import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { Db } from "@/lib/prisma";
import {
  DEAD_LETTER_BELL_WHERE,
  DEAD_LETTER_EMAIL_WHERE,
} from "@/lib/backoffice/queue-predicates";
import {
  readCompletionEvidence,
  readStandingConfigSkips,
  type StandingConfigSkip,
} from "@/lib/cron/completion-evidence";
import { isExpectedConfigSkip } from "@/lib/cron/config-skip";
import { readIdleCompletions } from "@/lib/cron/idle-skips";
import {
  assessOperationalCompletions,
  OPERATIONAL_COMPLETION_REQUIREMENTS,
} from "@/lib/cron/operational-health";
import {
  PENDING_AGE_LIMITS_MS,
  readPendingAges,
  WEBHOOK_GIVE_UP_MS,
} from "@/lib/cron/pending-ages";
import { SUPPORT_EMAIL } from "@/lib/company";
import { EMAIL_BUDGET_MS, SENDERS } from "@/lib/email/config";
import { deliver } from "@/lib/email/deliver";
import { HELD_PRE_LAUNCH } from "@/lib/email/held";
import type { PendingAges } from "@/lib/observability/betterstack-telemetry";
import {
  canaryAlertRecipient,
  escapeHtml,
} from "@/lib/observability/ingest-alert";
import {
  OPS_DIGEST_JOB,
  type OpsDigestSummary,
} from "@/lib/observability/ops-digest-summary";
import {
  readReleaseLag,
  unknownReleaseLag,
  type ReleaseLag,
} from "@/lib/observability/release-lag";
import { razorpayKeyMode } from "@/lib/payments/core/razorpay-key-mode";
import {
  checkGstRegistrationTurnover,
  GST_TURNOVER_ALARM_PAISE,
} from "@/lib/compliance/gst-turnover";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Sample ids per item; the rest is a count. */
const SAMPLE_IDS = 10;
/** A job whose last real run is older than this, while idle skips keep it fresh, is listed. */
const IDLE_ONLY_MS = 7 * DAY_MS;
const RUN_HISTORY_MS = 180 * DAY_MS;
/** Each vendor read; they run beside the database reads, inside the 24 s target timeout. */
const HTTP_TIMEOUT_MS = 4_000;
const HEARTBEAT_TIMEOUT_MS = 3_000;
const VENDOR_PAGE_LIMIT = 5;
const UPSTASH_WARN_PCT = 70;
const CANARY_JOB = "sentry-ingest-canary";

interface DigestItem {
  text: string;
  isNew: boolean;
  ids?: string[];
}

interface DigestSection {
  title: string;
  items: DigestItem[];
  notes: string[];
}

type SectionBody = Omit<DigestSection, "title">;

/** A vendor read's answer: a section body, or why it could not be read. */
type VendorRead = SectionBody | { unknown: string };

function formatAge(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(0, Math.round(ms / MINUTE_MS))} min`;
  if (ms < 2 * DAY_MS) return `${Math.round(ms / HOUR_MS)} h`;
  return `${Math.floor(ms / DAY_MS)} days`;
}

const since = (now: Date, ms: number) => new Date(now.getTime() - ms);

async function jobsSection(
  db: Db,
  environment: string,
  now: Date,
): Promise<SectionBody> {
  const watched = OPERATIONAL_COMPLETION_REQUIREMENTS.filter(
    (job) => job.tier === "watched",
  );
  const evidence = await readCompletionEvidence(db, environment, watched, now);
  const report = assessOperationalCompletions({
    ...evidence,
    now,
    tier: "watched",
  });
  const items: DigestItem[] = report.jobs
    .filter((job) => job.overdue)
    .map((job) => {
      const last = job.lastCompletedAt ? new Date(job.lastCompletedAt) : null;
      const overdueFor = last
        ? now.getTime() - last.getTime() - job.maxAgeMinutes * MINUTE_MS
        : null;
      return {
        text: `${job.jobName} overdue: last run ${last ? `${formatAge(now.getTime() - last.getTime())} ago` : "not within its budget"} (budget ${formatAge(job.maxAgeMinutes * MINUTE_MS)})`,
        isNew: overdueFor !== null && overdueFor < DAY_MS,
      };
    });
  const idle = await readIdleCompletions(db, environment, since(now, DAY_MS));
  if (idle.length > 0) {
    const real = await db.systemJobExecution.groupBy({
      by: ["jobName"],
      where: {
        jobName: { in: idle.map((job) => job.jobName) },
        status: { in: ["COMPLETED", "FAILED"] },
        result: { path: ["environment"], equals: environment },
        startedAt: { gte: since(now, RUN_HISTORY_MS) },
      },
      _max: { endedAt: true },
    });
    const lastReal = new Map(
      real.map((row) => [row.jobName, row._max.endedAt]),
    );
    const idleOnly = idle
      .map((job) => ({ jobName: job.jobName, ran: lastReal.get(job.jobName) }))
      .filter(
        ({ ran }) => !ran || now.getTime() - ran.getTime() > IDLE_ONLY_MS,
      );
    const label = ({ jobName, ran }: { jobName: string; ran?: Date | null }) =>
      `${jobName} (${ran ? formatAge(now.getTime() - ran.getTime()) : "none in 180 days"})`;
    const crossed = idleOnly.filter(
      ({ ran }) => ran && now.getTime() - ran.getTime() < IDLE_ONLY_MS + DAY_MS,
    );
    const older = idleOnly.filter((job) => !crossed.includes(job));
    if (crossed.length > 0) {
      items.push({
        text: `Only idle-skipped for 7 days: ${crossed.map(label).join(", ")}`,
        isNew: true,
      });
    }
    if (older.length > 0) {
      items.push({
        text: `${older.length} jobs only idle-skipped for 7+ days, last real run: ${older.slice(0, SAMPLE_IDS).map(label).join(", ")}`,
        isNew: false,
      });
    }
  }
  return {
    items,
    notes:
      items.length === 0 ? ["Every watched job ran within its budget."] : [],
  };
}

function skipsSection(
  skips: readonly StandingConfigSkip[],
  expected: readonly StandingConfigSkip[],
  now: Date,
): SectionBody {
  return {
    items: skips.map((skip) => ({
      text: `${skip.jobName}: ${skip.reason ?? "not configured"}, ${formatAge(now.getTime() - skip.firstSeenAt.getTime())} (${skip.tier})`,
      isNew: now.getTime() - skip.firstSeenAt.getTime() < DAY_MS,
    })),
    notes: [
      ...(skips.length === 0 && expected.length === 0
        ? ["No job is skipping for a missing setting."]
        : []),
      ...(expected.length > 0
        ? [
            `Expected while unregistered for GST: ${expected.map((skip) => skip.jobName).join(", ")}.`,
          ]
        : []),
    ],
  };
}

/** Any mode other than `live` holds mail outside our domain and the allowlist. */
function emailDeliveryMode(): "live" | "allowlist" {
  return process.env.EMAIL_DELIVERY_MODE?.trim().toLowerCase() === "live"
    ? "live"
    : "allowlist";
}

async function heldEmailSection(db: Db, now: Date): Promise<SectionBody> {
  const held = await db.failedEmail.groupBy({
    by: ["emailType"],
    where: {
      status: "DEAD_LETTER",
      lastError: HELD_PRE_LAUNCH,
      updatedAt: { gte: since(now, DAY_MS) },
    },
    _count: { _all: true },
  });
  const total = held.reduce((sum, row) => sum + row._count._all, 0);
  const byType = held
    .sort((a, b) => b._count._all - a._count._all)
    .slice(0, SAMPLE_IDS)
    .map((row) => `${row.emailType} ${row._count._all}`)
    .join(", ");
  return {
    items: [],
    notes: [
      `Delivery mode ${emailDeliveryMode()}; ${total} held in 24 h${total > 0 ? `: ${byType}` : ""}.`,
    ],
  };
}

interface DeadLetterSource {
  label: string;
  total: () => Promise<number>;
  fresh: () => Promise<number>;
  sample: () => Promise<{ id: string }[]>;
}

async function deadLetterSection(db: Db, now: Date): Promise<SectionBody> {
  const day = since(now, DAY_MS);
  const giveUp = since(now, WEBHOOK_GIVE_UP_MS);
  const freshEmail = { ...DEAD_LETTER_EMAIL_WHERE, updatedAt: { gte: day } };
  const freshOutbox = { ...DEAD_LETTER_BELL_WHERE, updatedAt: { gte: day } };
  const freshDelivery: Prisma.OutboundWebhookDeliveryWhereInput = {
    status: "DEAD_LETTER",
    updatedAt: { gte: day },
  };
  const givenUp: Prisma.WebhookEventWhereInput = {
    processed: false,
    receivedAt: { lt: giveUp },
  };
  const freshGivenUp: Prisma.WebhookEventWhereInput = {
    processed: false,
    receivedAt: { lt: giveUp, gte: since(giveUp, DAY_MS) },
  };
  const sample = { select: { id: true }, take: SAMPLE_IDS };
  const sources: DeadLetterSource[] = [
    {
      label: "email",
      total: () => db.failedEmail.count({ where: DEAD_LETTER_EMAIL_WHERE }),
      fresh: () => db.failedEmail.count({ where: freshEmail }),
      sample: () => db.failedEmail.findMany({ where: freshEmail, ...sample }),
    },
    {
      label: "notification",
      total: () =>
        db.notificationOutbox.count({ where: DEAD_LETTER_BELL_WHERE }),
      fresh: () => db.notificationOutbox.count({ where: freshOutbox }),
      sample: () =>
        db.notificationOutbox.findMany({ where: freshOutbox, ...sample }),
    },
    {
      label: "outbound webhook",
      total: () =>
        db.outboundWebhookDelivery.count({ where: { status: "DEAD_LETTER" } }),
      fresh: () => db.outboundWebhookDelivery.count({ where: freshDelivery }),
      sample: () =>
        db.outboundWebhookDelivery.findMany({
          where: freshDelivery,
          ...sample,
        }),
    },
    {
      label: "inbound webhook (past the 168 h give-up)",
      total: () => db.webhookEvent.count({ where: givenUp }),
      fresh: () => db.webhookEvent.count({ where: freshGivenUp }),
      sample: () =>
        db.webhookEvent.findMany({ where: freshGivenUp, ...sample }),
    },
  ];
  const items: DigestItem[] = [];
  for (const source of sources) {
    const total = await source.total();
    if (total === 0) continue;
    const fresh = await source.fresh();
    if (fresh > 0) {
      const ids = (await source.sample()).map((row) => row.id);
      items.push({
        text: `${fresh} new ${source.label} dead letters (${total} in total)`,
        isNew: true,
        ids,
      });
    } else {
      items.push({
        text: `${total} ${source.label} dead letters`,
        isNew: false,
      });
    }
  }
  return {
    items,
    notes: items.length === 0 ? ["No dead letters."] : [],
  };
}

const QUEUES: readonly { key: keyof PendingAges; label: string }[] = [
  { key: "refundsOwed", label: "Refunds owed" },
  { key: "payoutsStuck", label: "Payouts stuck" },
  { key: "dunningNotices", label: "Dunning notices" },
  { key: "disputesDue", label: "Disputes due" },
  { key: "webhookEvents", label: "Webhook events" },
  { key: "emailRetries", label: "Email retries" },
  { key: "notificationRetries", label: "Notification retries" },
];

async function queueSection(db: Db, now: Date): Promise<SectionBody> {
  const ages = await readPendingAges(db, now);
  const items: DigestItem[] = [];
  for (const { key, label } of QUEUES) {
    const ageMs = ages[key] * 1000;
    const limit = PENDING_AGE_LIMITS_MS[key];
    if (ageMs === 0 || ageMs <= limit) continue;
    items.push({
      text: `${label}: oldest ${formatAge(ageMs)} past due (limit ${formatAge(limit)})`,
      isNew: ageMs - limit < DAY_MS,
    });
  }
  return {
    items,
    notes:
      items.length === 0 ? ["Every queue's oldest item is within limit."] : [],
  };
}

async function webhookSection(db: Db, now: Date): Promise<SectionBody> {
  const providers = await db.webhookEvent.groupBy({
    by: ["provider"],
    _max: { receivedAt: true },
  });
  const resend = await db.emailEvent.aggregate({ _max: { receivedAt: true } });
  const lines = [
    ...providers.map((row) => ({
      provider: row.provider,
      at: row._max.receivedAt,
    })),
    { provider: "resend (email events)", at: resend._max.receivedAt },
  ]
    .sort((a, b) => a.provider.localeCompare(b.provider))
    .map(
      ({ provider, at }) =>
        `${provider} ${at ? `${formatAge(now.getTime() - at.getTime())} ago` : "never"}`,
    );
  return { items: [], notes: [`Last received: ${lines.join("; ")}.`] };
}

const telemetryRowSchema = z.object({
  sent: z.number(),
  r402: z.number(),
  r403: z.number(),
  r5xx: z.number(),
  network: z.number(),
  other: z.number(),
});

async function telemetrySection(
  db: Db,
  environment: string,
  now: Date,
): Promise<SectionBody> {
  const rows = await db.$queryRaw(Prisma.sql`
    SELECT
      COALESCE(sum((t->>'sent')::int), 0)::int AS sent,
      COALESCE(sum((t->'rejected'->>'402')::int), 0)::int AS r402,
      COALESCE(sum((t->'rejected'->>'403')::int), 0)::int AS r403,
      COALESCE(sum((t->'rejected'->>'5xx')::int), 0)::int AS r5xx,
      COALESCE(sum((t->'rejected'->>'network')::int), 0)::int AS network,
      COALESCE(sum((t->'rejected'->>'other')::int), 0)::int AS other
    FROM "SystemJobExecution" s
    CROSS JOIN LATERAL (SELECT s."result"->'telemetry' AS t) x
    WHERE s."startedAt" >= ${since(now, DAY_MS)}
      AND s."result"->>'environment' = ${environment}
      AND jsonb_typeof(t) = 'object'`);
  const [totals] = z.tuple([telemetryRowSchema]).parse(rows);
  const rejected =
    totals.r402 + totals.r403 + totals.r5xx + totals.network + totals.other;
  if (rejected === 0) {
    return {
      items: [],
      notes: [`Better Stack took all ${totals.sent} sends in 24 h.`],
    };
  }
  return {
    items: [
      {
        text: `Better Stack rejected ${rejected} telemetry sends in 24 h (402: ${totals.r402}, 403: ${totals.r403}, 5xx: ${totals.r5xx}, network: ${totals.network}, other: ${totals.other}; ${totals.sent} sent)`,
        isNew: true,
      },
    ],
    notes: [],
  };
}

const canaryResultSchema = z.object({
  summary: z.object({
    healthy: z.boolean(),
    verdict: z.string().optional(),
    skipped: z.string().optional(),
  }),
});

async function canarySection(
  db: Db,
  environment: string,
  now: Date,
): Promise<SectionBody> {
  const row = await db.systemJobExecution.findFirst({
    where: {
      jobName: CANARY_JOB,
      status: { in: ["COMPLETED", "FAILED", "CANCELLED"] },
      result: { path: ["environment"], equals: environment },
    },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true, result: true },
  });
  if (!row) return { items: [], notes: ["No canary run on record."] };
  const ago = `${formatAge(now.getTime() - row.startedAt.getTime())} ago`;
  const parsed = canaryResultSchema.safeParse(row.result);
  if (!parsed.success) {
    return {
      items: [
        {
          text: `Sentry ingest canary ended without a verdict ${ago}`,
          isNew: false,
        },
      ],
      notes: [],
    };
  }
  const { healthy, verdict, skipped } = parsed.data.summary;
  if (skipped) return { items: [], notes: [`Skipped ${ago}: ${skipped}.`] };
  if (healthy) return { items: [], notes: [`Accepted ${ago}.`] };
  return {
    items: [
      {
        text: `Sentry ingest canary: ${verdict ?? "unhealthy"} ${ago}`,
        isNew: now.getTime() - row.startedAt.getTime() < DAY_MS,
      },
    ],
    notes: [],
  };
}

const betterStackPageSchema = z.object({
  data: z.array(
    z.object({
      attributes: z.object({
        pronounceable_name: z.string().optional(),
        name: z.string().optional(),
        url: z.string().nullable().optional(),
        paused: z.boolean(),
        paused_at: z.string().nullable().optional(),
        policy_id: z.union([z.string(), z.number()]).nullable().optional(),
        call: z.boolean().optional(),
        sms: z.boolean().optional(),
        email: z.boolean().optional(),
        push: z.boolean().optional(),
      }),
    }),
  ),
  pagination: z.object({ next: z.string().nullable() }).optional(),
});
type BetterStackMonitor = z.infer<
  typeof betterStackPageSchema
>["data"][number]["attributes"];

async function readBetterStackList(
  apiKey: string,
  url: string,
): Promise<BetterStackMonitor[]> {
  const out: BetterStackMonitor[] = [];
  let next: string | null = url;
  for (let page = 0; next && page < VENDOR_PAGE_LIMIT; page++) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Better Stack answered ${res.status}`);
    const body = betterStackPageSchema.parse(await res.json());
    out.push(...body.data.map((item) => item.attributes));
    next = body.pagination?.next ?? null;
  }
  return out;
}

/** Paused monitors and heartbeats with their age, and those with no notification channel. */
async function betterStackSection(now: Date): Promise<VendorRead> {
  const apiKey = process.env.BETTERSTACK_API_KEY?.trim();
  if (!apiKey) return { unknown: "BETTERSTACK_API_KEY not configured" };
  try {
    const base = "https://uptime.betterstack.com/api/v2";
    const lists = [
      {
        kind: "monitor",
        rows: await readBetterStackList(apiKey, `${base}/monitors`),
      },
      {
        kind: "heartbeat",
        rows: await readBetterStackList(apiKey, `${base}/heartbeats`),
      },
    ];
    const items: DigestItem[] = [];
    for (const { kind, rows } of lists) {
      for (const row of rows) {
        const name = row.pronounceable_name ?? row.name ?? row.url ?? "unnamed";
        if (row.paused) {
          const at = row.paused_at ? new Date(row.paused_at) : null;
          const age = at ? now.getTime() - at.getTime() : null;
          items.push({
            text: `Better Stack ${kind} "${name}" paused${age === null ? "" : ` ${formatAge(age)}`}`,
            isNew: age !== null && age < DAY_MS,
          });
        } else if (
          (row.policy_id ?? null) === null &&
          !row.call &&
          !row.sms &&
          !row.email &&
          !row.push
        ) {
          items.push({
            text: `Better Stack ${kind} "${name}" is muted: no escalation policy and no notification channel`,
            isNew: false,
          });
        }
      }
    }
    const total = lists.reduce((sum, list) => sum + list.rows.length, 0);
    return {
      items,
      notes:
        items.length === 0
          ? [`All ${total} monitors and heartbeats are active.`]
          : [],
    };
  } catch (error) {
    return { unknown: error instanceof Error ? error.message : "read failed" };
  }
}

const upstashStatsSchema = z.object({ total_monthly_requests: z.number() });

/** Monthly Upstash commands against UPSTASH_MONTHLY_COMMAND_CAP, read from the management API. */
async function upstashSection(): Promise<VendorRead> {
  const apiKey = process.env.UPSTASH_MANAGEMENT_API_KEY?.trim();
  const email = process.env.UPSTASH_EMAIL?.trim();
  const databaseId = process.env.UPSTASH_DATABASE_ID?.trim();
  if (!apiKey || !email || !databaseId) {
    return { unknown: "Upstash management credentials not configured" };
  }
  try {
    const auth = Buffer.from(`${email}:${apiKey}`).toString("base64");
    const res = await fetch(
      `https://api.upstash.com/v2/redis/stats/${encodeURIComponent(databaseId)}`,
      {
        headers: { Authorization: `Basic ${auth}` },
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      },
    );
    if (!res.ok) return { unknown: `Upstash answered ${res.status}` };
    const used = upstashStatsSchema.parse(
      await res.json(),
    ).total_monthly_requests;
    const cap = Number(process.env.UPSTASH_MONTHLY_COMMAND_CAP);
    if (!Number.isFinite(cap) || cap <= 0) {
      return {
        items: [],
        notes: [
          `${used} commands this month; UPSTASH_MONTHLY_COMMAND_CAP is unset.`,
        ],
      };
    }
    const pct = (used / cap) * 100;
    const line = `Upstash at ${pct.toFixed(1)}% of the monthly command cap (${used} of ${cap})`;
    return pct >= UPSTASH_WARN_PCT
      ? { items: [{ text: line, isNew: false }], notes: [] }
      : { items: [], notes: [`${line}.`] };
  } catch (error) {
    return { unknown: error instanceof Error ? error.message : "read failed" };
  }
}

const isSet = (name: string) => Boolean(process.env[name]?.trim());
const yesNo = (value: boolean) => (value ? "yes" : "no");

/** Names and booleans only; EMAIL_DELIVERY_MODE is a mode, never a secret. */
function settingsSection(): SectionBody {
  return {
    items: [],
    notes: [
      [
        `EMAIL_DELIVERY_MODE: ${emailDeliveryMode()}`,
        `ENABLE_LIVE_PAYOUTS: ${process.env.ENABLE_LIVE_PAYOUTS === "true"}`,
        `PLATFORM_GSTIN set: ${yesNo(isSet("PLATFORM_GSTIN"))}`,
        `Captcha keys set: ${yesNo(isSet("TURNSTILE_SECRET_KEY") && isSet("NEXT_PUBLIC_TURNSTILE_SITE_KEY"))}`,
        `BETTERSTACK_HEARTBEAT_URL set: ${yesNo(isSet("BETTERSTACK_HEARTBEAT_URL"))}`,
        `ENABLE_BETTERSTACK_TELEMETRY: ${process.env.ENABLE_BETTERSTACK_TELEMETRY === "true"}`,
        `SENTRY_STATS_TOKEN set: ${yesNo(isSet("SENTRY_STATS_TOKEN"))}`,
        `SLACK_OPS_WEBHOOK_URL set: ${yesNo(isSet("SLACK_OPS_WEBHOOK_URL"))}`,
        `Razorpay key mode: ${razorpayKeyMode(process.env.RAZORPAY_KEY_ID)}`,
      ].join("; "),
    ],
  };
}

const rupees = (paise: number) =>
  `₹${Math.floor(paise / 100).toLocaleString("en-IN")}`;

/** Unregistered only: the daily GST registration turnover alarm (one Sentry event a day at most). */
async function gstRegistrationSection(db: Db, now: Date): Promise<SectionBody> {
  if (isSet("PLATFORM_GSTIN")) {
    return { items: [], notes: ["Registered: PLATFORM_GSTIN is set."] };
  }
  const check = await checkGstRegistrationTurnover(db, now);
  const line = `Unregistered; financial-year turnover ${rupees(check.turnoverPaise)} against the ${rupees(GST_TURNOVER_ALARM_PAISE)} alarm.`;
  return check.alarmed
    ? {
        items: [
          {
            text: `${line} Register for GST before ₹20,00,000 and set PLATFORM_GSTIN.`,
            isNew: true,
          },
        ],
        notes: [],
      }
    : { items: [], notes: [line] };
}

function releaseLagSection(lag: ReleaseLag, now: Date): SectionBody {
  if (lag.status === "unknown") {
    return { items: [], notes: [`Unknown: ${lag.reason}.`] };
  }
  if (lag.commitsBehind === 0) {
    return {
      items: [],
      notes: [`Production runs dev's head (${lag.buildSha.slice(0, 9)}).`],
    };
  }
  const age = (at: string | null) =>
    at ? formatAge(now.getTime() - Date.parse(at)) : "unknown";
  const line = [
    `Production is ${lag.commitsBehind} commits behind dev; oldest unreleased ${age(lag.oldestUnreleasedAt)}`,
    lag.scheduleChangeAt
      ? `schedule or registry change waiting ${age(lag.scheduleChangeAt)}`
      : null,
    lag.touches.length > 0 ? `touches ${lag.touches.join(", ")}` : null,
    lag.truncated ? "GitHub truncated the comparison" : null,
  ]
    .filter((part): part is string => part !== null)
    .join("; ");
  return lag.overdue
    ? { items: [{ text: line, isNew: false }], notes: [] }
    : { items: [], notes: [`${line}.`] };
}

function bodyOf(read: VendorRead): SectionBody {
  return "unknown" in read
    ? { items: [], notes: [`Unknown: ${read.unknown}.`] }
    : read;
}

function headlineOf(sections: readonly DigestSection[]): {
  headline: string;
  newItems: number;
  standingItems: number;
} {
  const items = sections.flatMap((section) => section.items);
  const newItems = items.filter((item) => item.isNew).length;
  const standingItems = items.length - newItems;
  return {
    headline:
      items.length === 0
        ? "All clear"
        : `${newItems} new, ${standingItems} standing`,
    newItems,
    standingItems,
  };
}

function itemLine(item: DigestItem): string {
  const ids = item.ids?.slice(0, SAMPLE_IDS) ?? [];
  return ids.length > 0 ? `${item.text} [ids: ${ids.join(", ")}]` : item.text;
}

/** One headline, new items first, standing items with their age, then context per section. */
function renderOpsDigest(
  sections: readonly DigestSection[],
  headline: string,
  now: Date,
): { subject: string; text: string; html: string } {
  const lists = [
    { title: "New since yesterday", isNew: true },
    { title: "Standing", isNew: false },
  ].flatMap(({ title, isNew }) => {
    const lines = sections.flatMap((section) =>
      section.items
        .filter((item) => item.isNew === isNew)
        .map((item) => `${section.title}: ${itemLine(item)}`),
    );
    return lines.length > 0 ? [{ title, lines }] : [];
  });
  const context = sections
    .filter((section) => section.notes.length > 0)
    .map((section) => `${section.title}: ${section.notes.join(" ")}`);
  const heading = (title: string) =>
    `<p style="margin:16px 0 4px;font-weight:600">${escapeHtml(title)}</p>`;
  const list = (lines: readonly string[]) =>
    `<ul style="margin:0;padding-left:20px">${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`;
  return {
    subject: `[Familiarise] Ops digest ${now.toISOString().slice(0, 10)}: ${headline}`,
    text: [
      headline,
      ...lists.flatMap(({ title, lines }) => [
        "",
        title,
        ...lines.map((line) => `- ${line}`),
      ]),
      "",
      "Context",
      ...context.map((line) => `- ${line}`),
    ].join("\n"),
    html: [
      `<p style="margin:0 0 12px;font-weight:600">${escapeHtml(headline)}</p>`,
      ...lists.map(({ title, lines }) => heading(title) + list(lines)),
      heading("Context") + list(context),
    ].join(""),
  };
}

/** Pings the digest heartbeat; `/fail` marks an explicit failure. */
async function pingHeartbeat(
  ok: boolean,
): Promise<OpsDigestSummary["heartbeat"]> {
  const url = process.env.BETTERSTACK_DIGEST_HEARTBEAT_URL?.trim();
  if (!url) return "not-configured";
  try {
    const res = await fetch(ok ? url : `${url.replace(/\/+$/, "")}/fail`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
    });
    if (!res.ok) return "ping-failed";
    return ok ? "pinged" : "pinged-fail";
  } catch {
    return "ping-failed";
  }
}

/**
 * The daily ops digest: bounded sequential database reads, vendor reads beside
 * them, one email that is always sent, then the heartbeat. It never reports to
 * Sentry and never repairs anything.
 */
export async function runOpsDigest(
  opts: { now?: Date; environment?: string } = {},
): Promise<OpsDigestSummary> {
  const now = opts.now ?? new Date();
  const environment =
    opts.environment ??
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
    process.env.SENTRY_ENVIRONMENT ??
    "unknown";
  const unavailableSections: string[] = [];
  let standingSkips: StandingConfigSkip[] = [];
  let releaseLag = unknownReleaseLag("digest failed before the GitHub read");
  try {
    const { default: db } = await import("@/lib/prisma");
    const betterStack = betterStackSection(now);
    const upstash = upstashSection();
    const lag = readReleaseLag(now);
    const sections: DigestSection[] = [];
    const read = async (
      title: string,
      body: () => Promise<SectionBody>,
    ): Promise<void> => {
      try {
        sections.push({ title, ...(await body()) });
      } catch (error) {
        unavailableSections.push(title);
        sections.push({
          title,
          items: [
            {
              text: `unavailable (${error instanceof Error ? error.name : "error"})`,
              isNew: false,
            },
          ],
          notes: [],
        });
      }
    };
    // PG_POOL_MAX=1: one statement at a time, each bounded.
    await read("Jobs", () => jobsSection(db, environment, now));
    await read("Config skips", async () => {
      const skips = await readStandingConfigSkips(
        db,
        environment,
        OPERATIONAL_COMPLETION_REQUIREMENTS,
        now,
      );
      // The stored summary feeds /api/health/jobs, so an expected skip never pages.
      standingSkips = skips.filter(
        (skip) => !isExpectedConfigSkip(skip.reason),
      );
      return skipsSection(
        standingSkips,
        skips.filter((skip) => isExpectedConfigSkip(skip.reason)),
        now,
      );
    });
    await read("Held email", () => heldEmailSection(db, now));
    await read("Dead letters", () => deadLetterSection(db, now));
    await read("Queue ages", () => queueSection(db, now));
    await read("Inbound webhooks", () => webhookSection(db, now));
    await read("Telemetry", () => telemetrySection(db, environment, now));
    await read("Sentry ingest", () => canarySection(db, environment, now));
    await read("Better Stack", async () => bodyOf(await betterStack));
    await read("Upstash", async () => bodyOf(await upstash));
    await read("GST registration", () => gstRegistrationSection(db, now));
    await read("Release lag", async () => {
      releaseLag = await lag;
      return releaseLagSection(releaseLag, now);
    });
    sections.push({ title: "Settings", ...settingsSection() });

    const counts = headlineOf(sections);
    const email = renderOpsDigest(sections, counts.headline, now);
    const sent = await deliver(
      {
        from: SENDERS.ops,
        to: canaryAlertRecipient(),
        replyTo: SUPPORT_EMAIL,
        ...email,
      },
      OPS_DIGEST_JOB,
      {
        entityRef: `${OPS_DIGEST_JOB}:${now.toISOString().slice(0, 10)}`,
        budgetMs: EMAIL_BUDGET_MS.JOB,
      },
    );
    return {
      success: sent.success,
      heartbeat: await pingHeartbeat(sent.success),
      ...counts,
      unavailableSections,
      standingSkips: standingSkips.map(summaryOfSkip),
      releaseLag,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "ops-digest.failed",
        error: error instanceof Error ? error.name : "error",
      }),
    );
    return {
      success: false,
      heartbeat: await pingHeartbeat(false),
      headline: "Digest failed",
      newItems: 0,
      standingItems: 0,
      unavailableSections,
      standingSkips: standingSkips.map(summaryOfSkip),
      releaseLag,
    };
  }
}

function summaryOfSkip(
  skip: StandingConfigSkip,
): OpsDigestSummary["standingSkips"][number] {
  return {
    jobName: skip.jobName,
    tier: skip.tier,
    reason: skip.reason,
    firstSeenAt: skip.firstSeenAt.toISOString(),
  };
}
