"use client";

import { formatDateLabel, formatDateTimeLabel } from "@/lib/time/display";
import { AppealAction } from "./AppealAction";
import { removalOutcomeCopy } from "./removal-outcome";
import {
  decisionInForce,
  OUTCOME_LABEL,
  useCaseResolution,
  type CaseResolution,
} from "./resolution-data";

type Decision = CaseResolution["decisions"][number];

/** Only the decision in force can be appealed, never one that decides an appeal; a replaced one says so. */
function DecisionCard({
  decision,
  inForce,
  resolution,
}: Readonly<{
  decision: Decision;
  inForce: boolean;
  resolution: { reviewsRemoval?: boolean; isAppeal: boolean };
}>) {
  const copy = removalOutcomeCopy(resolution, decision.outcome);
  const appealOpen =
    inForce &&
    copy.appealable &&
    decision.appealUntil !== null &&
    new Date(decision.appealUntil).getTime() > Date.now();
  return (
    <article className="space-y-2 rounded-lg border border-border p-3">
      <h4 className="font-medium">
        {copy.label ?? OUTCOME_LABEL[decision.outcome]}
        {inForce ? "" : " · Replaced by a later decision"}
      </h4>
      <p className="whitespace-pre-wrap">{decision.explanation}</p>
      {inForce && copy.note && (
        <p className="text-muted-foreground">{copy.note}</p>
      )}
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
  const current = decisionInForce(decisions);
  return (
    <section
      aria-label="Case resolution"
      className="space-y-3 rounded-lg border border-border bg-card p-3 text-sm"
    >
      {decisions.length > 0 && (
        <>
          <h3 className="font-semibold">Decision</h3>
          {decisions.map((decision) => (
            <DecisionCard
              key={decision.id}
              decision={decision}
              inForce={decision.id === current?.id}
              resolution={{
                reviewsRemoval: query.data?.reviewsRemoval,
                isAppeal: query.data?.isAppeal ?? false,
              }}
            />
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
