import * as Sentry from "@sentry/nextjs";
import { scheduleAfter } from "@/lib/api/after-safe";
import { EMAIL_BUDGET_MS } from "@/lib/email/config";
import {
  attemptStaged,
  type StagedRecipientEmail,
} from "@/lib/email/send-to-recipients";
import {
  attemptTrigger,
  INLINE_BELL_ATTEMPT_LIMIT,
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
  const bells = [
    ...new Map(
      (bundle.bells ?? [])
        .filter((row): row is StagedTrigger => Boolean(row))
        .map((row) => [row.id, row]),
    ).values(),
  ];
  const emails = (bundle.emails ?? []).filter(
    (entry) => entryRows(entry).length > 0,
  );
  if (bells.length === 0 && emails.length === 0) {
    return Promise.resolve();
  }
  return scheduleAfter(async () => {
    const errors: unknown[] = [];
    await Promise.all([
      ...bells.slice(0, INLINE_BELL_ATTEMPT_LIMIT).map((row) =>
        attemptTrigger(row, { suppressSentry: true })
          .then((result) => {
            if (!result.success)
              errors.push(new Error("Notification attempt failed"));
          })
          .catch((err: unknown) => {
            console.error(`Failed to deliver ${op}`, err);
            errors.push(err);
          }),
      ),
      ...emails.map((entry) =>
        attemptStaged(
          entryRows(entry),
          entry.emailType,
          entry.budgetMs ?? EMAIL_BUDGET_MS.LIFECYCLE,
        ).catch((err: unknown) => {
          console.error(`Failed to deliver email ${entry.emailType}`, err);
          errors.push(err);
        }),
      ),
    ]);
    if (errors.length > 0) {
      const first = errors[0];
      Sentry.captureException(
        first instanceof Error ? first : new Error(String(first)),
        {
          tags: { subsystem: "novu", op },
          extra: {
            errorCount: errors.length,
            bellCount: bells.length,
            emailBatchCount: emails.length,
          },
        },
      );
    }
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
