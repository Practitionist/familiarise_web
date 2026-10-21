"use client";

import { formatDateLabel, formatDateTimeLabel } from "@/lib/time/display";
import { AppealAction } from "./AppealAction";
import {
  OUTCOME_LABEL,
  useCaseResolution,
  type CaseResolution,
} from "./resolution-data";

type Decision = CaseResolution["decisions"][number];

function DecisionCard({ decision }: Readonly<{ decision: Decision }>) {
  const appealOpen =
    decision.appealUntil !== null &&
    new Date(decision.appealUntil).getTime() > Date.now();
  return (
    <article className="space-y-2 rounded-lg border border-border p-3">
      <h4 className="font-medium">{OUTCOME_LABEL[decision.outcome]}</h4>
      <p className="whitespace-pre-wrap">{decision.explanation}</p>
      <p className="text-xs text-muted-foreground">
        Decided {formatDateLabel(new Date(decision.createdAt))}
        {appealOpen && decision.appealUntil
          ? ` · You can appeal until ${formatDateTimeLabel(new Date(decision.appealUntil))}`
          : ""}
      </p>
      {appealOpen && (
        <AppealAction
          target={{ decisionId: decision.id }}
          prompt="Explain what should be reconsidered"
        />
      )}
    </article>
  );
}

/** What the customer sees of a case's resolution: decisions, appeals and their receipt. Never operator controls. */
export function CustomerCaseResolution({
  caseId,
}: Readonly<{ caseId: string }>) {
  const query = useCaseResolution(caseId);
  const decisions = query.data?.decisions ?? [];
  return (
    <section
      aria-label="Case resolution"
      className="space-y-3 rounded-lg border border-border bg-card p-3 text-sm"
    >
      {decisions.length > 0 && (
        <>
          <h3 className="font-semibold">Decision</h3>
          {decisions.map((decision) => (
            <DecisionCard key={decision.id} decision={decision} />
          ))}
        </>
      )}
      {query.isError && (
        <p className="text-xs text-muted-foreground">
          Decisions on this request couldn&apos;t be loaded.{" "}
          <button
            type="button"
            className="underline underline-offset-4"
            onClick={() => void query.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      <a
        className="block text-sm underline underline-offset-4"
        href={`/api/support/cases/${caseId}/receipt`}
      >
        Download submitted complaint
      </a>
    </section>
  );
}
