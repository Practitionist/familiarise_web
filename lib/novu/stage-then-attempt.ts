import * as Sentry from "@sentry/nextjs";
import { scheduleAfter } from "@/lib/api/after-safe";
import { EMAIL_BUDGET_MS } from "@/lib/email/config";
import {
  attemptStaged,
  type StagedRecipientEmail,
} from "@/lib/email/send-to-recipients";
import {
  attemptTrigger,
  type StagedTrigger,
  type TriggerResult,
} from "./outbox";

export type StagedEmailBundleEntry =
  | {
      rows: StagedRecipientEmail[];
      emailType: string;
      budgetMs?: number;
    }
  | {
      list: StagedRecipientEmail[];
      emailType: string;
      budgetMs?: number;
    };

export interface StagedNotificationBundle {
  bells?: Array<StagedTrigger | null | undefined>;
  emails?: StagedEmailBundleEntry[];
}

function entryRows(entry: StagedEmailBundleEntry): StagedRecipientEmail[] {
  return "rows" in entry ? entry.rows : entry.list;
}

function report(message: string, err: unknown): void {
  console.error(message, err);
  Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
    tags: { subsystem: "novu" },
  });
}

function isBundle(
  value: TriggerResult | TriggerResult[] | StagedNotificationBundle,
): value is StagedNotificationBundle {
  return (
    !Array.isArray(value) &&
    typeof value === "object" &&
    value !== null &&
    ("bells" in value || "emails" in value)
  );
}

/**
 * Dispatches staged Novu bells and staged recipient emails after the response
 * settles, isolating individual delivery failures so none blocks the batch.
 */
export function flushNotificationsAfter(
  bundle: StagedNotificationBundle,
  op = "flushNotificationsAfter",
): Promise<void> {
  const bells = (bundle.bells ?? []).filter((row): row is StagedTrigger =>
    Boolean(row),
  );
  const emails = (bundle.emails ?? []).filter(
    (entry) => entryRows(entry).length > 0,
  );
  if (bells.length === 0 && emails.length === 0) {
    return Promise.resolve();
  }
  return scheduleAfter(async () => {
    await Promise.all([
      ...bells.map((row) =>
        attemptTrigger(row).catch((err) =>
          report(`Failed to deliver ${op}`, err),
        ),
      ),
      ...emails.map((entry) =>
        attemptStaged(
          entryRows(entry),
          entry.emailType,
          entry.budgetMs ?? EMAIL_BUDGET_MS.LIFECYCLE,
        ).catch((err) =>
          report(`Failed to deliver email ${entry.emailType}`, err),
        ),
      ),
    ]);
  }, op);
}

/**
 * Awaits outbox staging before the response returns and defers wire delivery
 * to `scheduleAfter`. Supports single triggers, arrays, or combined bundles.
 */
export async function stageNowAttemptAfter(
  label: string,
  stage: () => Promise<
    TriggerResult | TriggerResult[] | StagedNotificationBundle
  >,
): Promise<void> {
  let produced: TriggerResult | TriggerResult[] | StagedNotificationBundle;
  try {
    produced = await stage();
  } catch (err) {
    report(`Failed to stage ${label}`, err);
    return;
  }
  if (isBundle(produced)) {
    await flushNotificationsAfter(produced, label);
    return;
  }
  const results = Array.isArray(produced) ? produced : [produced];
  const bells = results
    .map((r) => r.staged)
    .filter((row): row is StagedTrigger => Boolean(row));
  if (bells.length === 0) return;
  await flushNotificationsAfter({ bells }, label);
}
