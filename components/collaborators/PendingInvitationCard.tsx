"use client";

/**
 * An invitation the viewer has not answered: who asks, the terms in full, the
 * sessions it would put on their calendar, and when it lapses. Accepting is
 * confirmed against the terms on screen and sends them, so terms the host
 * changed in between are shown again instead of being accepted unseen.
 */

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { useToast } from "@/hooks/use-toast";
import {
  CollaborationRefusal,
  describeRefusal,
  useRespondToInvitation,
} from "@/hooks/use-collaborations";
import {
  REINVITE_COOLDOWN_DAYS,
  bpsToPercent,
  inviteExpiresAt,
} from "@/lib/collaborators/rules";
import { goHref } from "@/lib/dashboard/go";
import type { SeenTerms } from "@/schemas/collaborators";
import { useFocusFallback } from "./CollaboratorRow";
import {
  ClassScheduleSummary,
  WebinarScheduleSummary,
} from "./ScheduleSummaries";
import { TermsSummary } from "./TermsSummary";
import type { CollaborationWithPlan } from "./types";

const sameTerms = (a: SeenTerms, b: SeenTerms) =>
  a.role === b.role && a.sharePercent === b.sharePercent;

export function PendingInvitationCard({
  collab,
}: Readonly<{ collab: CollaborationWithPlan }>) {
  const ref = useFocusFallback<HTMLDivElement>();
  const respond = useRespondToInvitation();
  const { toast } = useToast();
  // The terms a refused accept carried, beside the terms on screen they replaced.
  const [changed, setChanged] = useState<{
    terms: SeenTerms;
    replaced: SeenTerms;
  } | null>(null);

  const listed: SeenTerms = {
    role: collab.role,
    sharePercent: bpsToPercent(collab.revenueShareBps),
  };
  // Once the list itself has reloaded, it is the newer word on the terms.
  const terms =
    changed && sameTerms(changed.replaced, listed) ? changed.terms : listed;

  const owner =
    collab.webinarPlan?.consultantProfile ??
    collab.classPlan?.consultantProfile;
  const hostName = owner?.user.name ?? null;
  const inviterName = collab.invitedBy?.user.name ?? null;

  const summary = (
    <TermsSummary
      role={terms.role}
      sharePercent={terms.sharePercent}
      audience="collaborator"
      planPricePaise={collab.planPrice}
      expiresAt={
        collab.updatedAt ? inviteExpiresAt(new Date(collab.updatedAt)) : null
      }
    />
  );

  return (
    <Card ref={ref} className="border-amber-200/80 bg-amber-50/40 shadow-sm">
      <div className="space-y-4 p-4 sm:p-5">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <Badge className="rounded-md border-0 bg-amber-700 px-2 py-0.5 text-xs font-semibold text-white hover:bg-amber-700">
              Invitation
            </Badge>
            <Badge
              variant="secondary"
              className="rounded-md border border-amber-200/80 bg-white px-2 py-0.5 text-xs font-medium text-zinc-700"
            >
              {collab.planType === "webinar" ? "Webinar" : "Class"}
            </Badge>
          </div>
          <h3 className="text-base font-semibold tracking-tight text-foreground">
            {collab.planTitle}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {hostName ? `Hosted by ${hostName}.` : "Hosted by an organisation."}
            {inviterName && inviterName !== hostName
              ? ` Invited by ${inviterName}.`
              : ""}
          </p>
        </div>

        {changed && (
          <p
            role="status"
            className="rounded-lg border border-amber-300 bg-amber-100 px-3 py-2 text-sm font-medium text-amber-950"
          >
            The host changed this invitation after it was sent. These are the
            new terms; read them before you accept.
          </p>
        )}

        {summary}

        <div className="rounded-xl border border-border bg-background px-3 py-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Schedule
          </p>
          {collab.webinarPlan && (
            <WebinarScheduleSummary plan={collab.webinarPlan} />
          )}
          {collab.classPlan && <ClassScheduleSummary plan={collab.classPlan} />}
          <p className="mt-2 text-xs text-muted-foreground">
            If you accept, every session of this plan is held on your calendar.
          </p>
        </div>

        {collab.payoutAccountReady === false && (
          <p className="text-sm text-muted-foreground">
            You have no verified payout account yet. You can accept without one,
            but earnings cannot be paid out until you{" "}
            <Link
              href={goHref("expert", "settings/get-paid")}
              className="font-medium text-foreground underline"
            >
              set up payouts
            </Link>
            .
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <ConfirmDialog
            trigger={
              <Button type="button" className="min-h-11">
                Accept…
              </Button>
            }
            title="Accept this invitation?"
            description={`You are joining “${collab.planTitle}” on these terms.`}
            confirmLabel="Accept and join"
            cancelLabel="Not now"
            onConfirm={async () => {
              try {
                await respond.mutateAsync({
                  collaboratorId: collab.id,
                  response: "ACCEPTED",
                  seenTerms: terms,
                });
                toast({
                  title: "You have joined the team",
                  description: `“${collab.planTitle}” is now among the plans you help deliver.`,
                });
              } catch (error) {
                if (!(error instanceof CollaborationRefusal)) throw error;
                if (error.code === "TERMS_CHANGED" && error.detail.terms) {
                  setChanged({ terms: error.detail.terms, replaced: terms });
                }
                throw new Error(describeRefusal(error).sentence);
              }
            }}
          >
            {summary}
          </ConfirmDialog>
          <ConfirmDialog
            trigger={
              <Button
                type="button"
                variant="outline"
                className="min-h-11 bg-background"
              >
                Decline…
              </Button>
            }
            title="Decline this invitation?"
            description={`The host is told you declined. “${collab.planTitle}” cannot invite you again for ${REINVITE_COOLDOWN_DAYS} days.`}
            confirmLabel="Decline"
            cancelLabel="Not now"
            tone="destructive"
            onConfirm={async () => {
              try {
                await respond.mutateAsync({
                  collaboratorId: collab.id,
                  response: "DECLINED",
                });
                toast({ title: "Invitation declined" });
              } catch (error) {
                if (!(error instanceof CollaborationRefusal)) throw error;
                throw new Error(describeRefusal(error).sentence);
              }
            }}
          />
        </div>
      </div>
    </Card>
  );
}
