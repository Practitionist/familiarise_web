"use client";

/**
 * The Collaborations page. Personal view: invitations waiting for the viewer,
 * the plans they help deliver, and their own plans that have a team.
 * Organisation view (`orgView`): every plan the organisation hosts that has a
 * team, managed by its operators. `orgScope` limits the hosted plans to one
 * organisation; unset, it shows the viewer's personal plans.
 */

import { useId, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/DataCard";
import { useMyCollaborations } from "@/hooks/use-collaborations";
import { goHref } from "@/lib/dashboard/go";
import { ActiveCollaborationCard } from "./ActiveCollaborationCard";
import { HostedPlanCard } from "./HostedPlanCard";
import { PendingInvitationCard } from "./PendingInvitationCard";
import type {
  CollaborationsData,
  CollaborationWithPlan,
  HostedPlanEntry,
} from "./types";

function collaborationsOf(data: CollaborationsData): CollaborationWithPlan[] {
  return [
    ...data.webinarCollaborations.flatMap((c) =>
      c.webinarPlan
        ? [
            {
              ...c,
              planType: "webinar" as const,
              planId: c.webinarPlan.id,
              planTitle: c.webinarPlan.title,
              planPrice: c.webinarPlan.price,
            },
          ]
        : [],
    ),
    ...data.classCollaborations.flatMap((c) =>
      c.classPlan
        ? [
            {
              ...c,
              planType: "class" as const,
              planId: c.classPlan.id,
              planTitle: c.classPlan.title,
              planPrice: c.classPlan.price,
            },
          ]
        : [],
    ),
  ];
}

function hostedPlansOf(data: CollaborationsData): HostedPlanEntry[] {
  return [
    ...data.hostedWebinarPlans.map((p) => ({
      planType: "webinar" as const,
      planId: p.id,
      title: p.title,
      price: p.price,
      collaborators: p.collaborators,
      host: p.consultantProfile?.user,
      webinarPlan: p,
    })),
    ...data.hostedClassPlans.map((p) => ({
      planType: "class" as const,
      planId: p.id,
      title: p.title,
      price: p.price,
      collaborators: p.collaborators,
      host: p.consultantProfile?.user,
      classPlan: p,
    })),
  ];
}

/** A titled list that takes the focus when a card that held it leaves. */
function Section({
  title,
  count,
  children,
}: Readonly<{ title: string; count: number; children: ReactNode }>) {
  const headingId = useId();
  return (
    <section tabIndex={-1} aria-labelledby={headingId} className="outline-none">
      <h2
        id={headingId}
        className="mb-4 text-sm font-semibold tracking-tight text-foreground"
      >
        {title}{" "}
        <span className="font-normal text-muted-foreground">({count})</span>
      </h2>
      {children}
    </section>
  );
}

export function InvitationsPanel({
  orgScope,
  orgView = false,
}: Readonly<{ orgScope?: string; orgView?: boolean }> = {}) {
  const { data, isPending, isError, error, refetch } = useMyCollaborations({
    orgScope,
    orgView,
  });

  if (isPending) {
    return (
      <div role="status" className="flex items-center justify-center py-8">
        <Loader2 aria-hidden className="h-6 w-6 animate-spin text-zinc-400" />
        <span className="sr-only">Loading collaborations</span>
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load collaborations"
        description={error.message}
        action={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Try again
          </Button>
        }
      />
    );
  }

  const collaborations = collaborationsOf(data);
  const invitations = collaborations.filter((c) => c.status === "PENDING");
  const delivering = collaborations.filter((c) => c.status === "ACCEPTED");
  const hostedPlans = hostedPlansOf(data);

  if (collaborations.length === 0 && hostedPlans.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No collaborations yet"
        description={
          orgView
            ? "A webinar or class of this organisation appears here once it has a collaborator. Its host invites the first one from the plan's Collaborators tab."
            : "Invitations from other experts appear here. To bring someone onto one of your webinars or classes, open the plan and use its Collaborators tab."
        }
        action={
          orgView ? undefined : (
            <Button asChild variant="outline" size="sm">
              <Link href={goHref("expert", "sell/programs")}>
                Go to your group programs
              </Link>
            </Button>
          )
        }
      />
    );
  }

  if (orgView) {
    return (
      <Section title="Plans with collaborators" count={hostedPlans.length}>
        <div className="space-y-3">
          {hostedPlans.map((plan) => (
            <HostedPlanCard
              key={`${plan.planType}-${plan.planId}`}
              plan={plan}
              hostUser={plan.host}
              hostLabel={plan.host?.name ?? "The organisation"}
            />
          ))}
        </div>
      </Section>
    );
  }

  return (
    <div className="space-y-8">
      <Section title="Invitations for you" count={invitations.length}>
        {invitations.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No invitation is waiting for your answer.
          </p>
        ) : (
          <div className="space-y-3">
            {invitations.map((collab) => (
              <PendingInvitationCard key={collab.id} collab={collab} />
            ))}
          </div>
        )}
      </Section>

      {delivering.length > 0 && (
        <Section title="Plans you help deliver" count={delivering.length}>
          <div className="space-y-3">
            {delivering.map((collab) => (
              <ActiveCollaborationCard key={collab.id} collab={collab} />
            ))}
          </div>
        </Section>
      )}

      {hostedPlans.length > 0 && (
        <Section
          title="Your plans with collaborators"
          count={hostedPlans.length}
        >
          <div className="space-y-3">
            {hostedPlans.map((plan) => (
              <HostedPlanCard
                key={`${plan.planType}-${plan.planId}`}
                plan={plan}
                hostUser={data.hostUser}
              />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
