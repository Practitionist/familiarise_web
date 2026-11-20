import * as React from "react";
import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";

export type CollaborationLifecycleEvent =
  | "INVITED"
  | "TERMS_CHANGED"
  | "ACCEPTED"
  | "DECLINED"
  | "REMOVED"
  | "WITHDRAWN"
  | "EXPIRED"
  | "EXPIRING_SOON";

/** What a plan's seat holders hear when its named co-presenter changes. */
export type CohostChangeEvent = "COHOST_JOINED" | "COHOST_LEFT";

export type CollaborationEmailEvent =
  CollaborationLifecycleEvent | CohostChangeEvent;

/**
 * The sentence a seat holder reads, on the bell and in the email. It states
 * the fact and nothing else; its wording is under legal review, so every
 * surface reads it from here.
 */
export function cohostChangeSentence(
  event: CohostChangeEvent,
  cohostName: string | null,
  planTitle: string,
): string {
  const who = cohostName ?? "A co-host";
  return event === "COHOST_JOINED"
    ? `${who} is now co-hosting ${planTitle}.`
    : `${who} is no longer co-hosting ${planTitle}.`;
}

/** The share of a seat sold for one thousand rupees, in whole rupees. */
const EXAMPLE_SEAT_RUPEES = 1000;
const rupees = (amount: number) => `₹${amount.toLocaleString("en-IN")}`;

export interface CollaborationLifecycleEmailProps {
  recipientName?: string;
  event: CollaborationEmailEvent;
  /** The person who made the change, when one did and they are not the reader. */
  actorName?: string;
  collaboratorName?: string;
  planTitle: string;
  planKindLabel: string;
  roleLabel: string;
  /** What the role may do, listed with the terms. */
  roleCan?: readonly string[];
  revenueSharePct?: number;
  /** The reader is the collaborator; otherwise the plan's host side. */
  toCollaborator?: boolean;
  /** The row was still an invitation: it never held a place on the team. */
  pendingInvite?: boolean;
  /** The day a pending invitation lapses, already in the reader's zone. */
  expiresOn?: string;
  dashboardUrl: string;
  /** Set only for a notice the reader can switch off. */
  unsubscribeUrl?: string | null;
}

export function collaborationLifecycleSubject(
  args: Readonly<{
    event: CollaborationEmailEvent;
    planTitle: string;
    collaboratorName?: string;
    roleLabel: string;
    toCollaborator?: boolean;
    pendingInvite?: boolean;
  }>,
): string {
  const who = args.collaboratorName ?? "A collaborator";
  switch (args.event) {
    case "INVITED":
      return `Invitation to collaborate as ${args.roleLabel}: ${args.planTitle}`;
    case "TERMS_CHANGED":
      return `Your invitation to ${args.planTitle} has new terms`;
    case "ACCEPTED":
      return args.toCollaborator
        ? `Your terms as ${args.roleLabel} on ${args.planTitle}`
        : `${who} accepted your ${args.roleLabel} invite for ${args.planTitle}`;
    case "DECLINED":
      return `${who} declined your ${args.roleLabel} invite for ${args.planTitle}`;
    case "REMOVED":
      return args.pendingInvite
        ? `Your invitation to ${args.planTitle} was withdrawn`
        : `You are no longer ${args.roleLabel} on ${args.planTitle}`;
    case "WITHDRAWN":
      return `${who} left ${args.planTitle}`;
    case "EXPIRED":
      return `Collaboration invite expired for ${args.planTitle}`;
    case "EXPIRING_SOON":
      return `Your invitation to ${args.planTitle} lapses soon`;
    case "COHOST_JOINED":
      return `A new co-host on ${args.planTitle}`;
    case "COHOST_LEFT":
      return `A co-host change on ${args.planTitle}`;
  }
}

function Terms({
  roleLabel,
  roleCan = [],
  revenueSharePct,
  toCollaborator,
}: Readonly<
  Pick<
    CollaborationLifecycleEmailProps,
    "roleLabel" | "roleCan" | "revenueSharePct" | "toCollaborator"
  >
>) {
  const share =
    typeof revenueSharePct === "number"
      ? Math.floor((EXAMPLE_SEAT_RUPEES * revenueSharePct) / 100)
      : null;
  const whose = toCollaborator ? "your" : "their";
  return (
    <>
      <Text style={paragraph}>
        <strong>Role:</strong> {roleLabel}
        {roleCan.length > 0 ? `. ${roleCan.join(". ")}.` : null}
      </Text>
      {share === null ? null : (
        <Text style={paragraph}>
          <strong>Share:</strong> {revenueSharePct}% of each seat. For example,
          of a seat sold for {rupees(EXAMPLE_SEAT_RUPEES)}, {rupees(share)} is{" "}
          {whose} share before the platform fee, which is then taken from each
          share at that person&apos;s own rate.
        </Text>
      )}
    </>
  );
}

export default function CollaborationLifecycleEmail({
  recipientName = "there",
  event,
  actorName,
  collaboratorName,
  planTitle,
  planKindLabel,
  roleLabel,
  roleCan,
  revenueSharePct,
  toCollaborator = false,
  pendingInvite = false,
  expiresOn,
  dashboardUrl,
  unsubscribeUrl,
}: Readonly<CollaborationLifecycleEmailProps>) {
  const subject = collaborationLifecycleSubject({
    event,
    planTitle,
    collaboratorName,
    roleLabel,
    toCollaborator,
    pendingInvite,
  });
  const who = collaboratorName ?? "A collaborator";
  const respondBy = expiresOn ? ` by ${expiresOn}` : "";
  const terms = (
    <Terms
      roleLabel={roleLabel}
      roleCan={roleCan}
      revenueSharePct={revenueSharePct}
      toCollaborator={toCollaborator}
    />
  );
  const learner = event === "COHOST_JOINED" || event === "COHOST_LEFT";

  return (
    <EmailLayout
      preview={subject}
      requiredNotice={event !== "EXPIRING_SOON"}
      unsubscribeUrl={event === "EXPIRING_SOON" ? unsubscribeUrl : undefined}
    >
      <Text style={heading}>{subject}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>

      {event === "INVITED" ? (
        <>
          <Text style={paragraph}>
            {actorName ? (
              <>
                <strong>{actorName}</strong> invited you
              </>
            ) : (
              "You are invited"
            )}{" "}
            to collaborate on the {planKindLabel.toLowerCase()}{" "}
            <strong>{planTitle}</strong>. Review the schedule, then accept or
            decline{respondBy}; after that the invitation lapses.
          </Text>
          {terms}
        </>
      ) : null}

      {event === "TERMS_CHANGED" ? (
        <>
          <Text style={paragraph}>
            The terms of your invitation to the {planKindLabel.toLowerCase()}{" "}
            <strong>{planTitle}</strong> changed. These are the terms you would
            now accept. You can accept or decline{respondBy}.
          </Text>
          {terms}
        </>
      ) : null}

      {event === "ACCEPTED" ? (
        <>
          <Text style={paragraph}>
            {toCollaborator ? (
              <>
                You accepted the invitation to join <strong>{planTitle}</strong>
                . These are the terms you accepted.
              </>
            ) : (
              <>
                <strong>{who}</strong> accepted your invitation to join{" "}
                <strong>{planTitle}</strong>. These are the terms they accepted.
              </>
            )}
          </Text>
          {terms}
        </>
      ) : null}

      {event === "DECLINED" ? (
        <Text style={paragraph}>
          <strong>{who}</strong> declined your invitation to collaborate on{" "}
          <strong>{planTitle}</strong> as <strong>{roleLabel}</strong>. You can
          invite another collaborator from the plan&apos;s settings.
        </Text>
      ) : null}

      {event === "REMOVED" ? (
        <Text style={paragraph}>
          {pendingInvite ? (
            <>
              The invitation to collaborate on <strong>{planTitle}</strong> as{" "}
              <strong>{roleLabel}</strong> was withdrawn
              {actorName ? (
                <>
                  {" "}
                  by <strong>{actorName}</strong>
                </>
              ) : null}
              . There is nothing for you to do.
            </>
          ) : (
            <>
              Your place as <strong>{roleLabel}</strong> on{" "}
              <strong>{planTitle}</strong> was ended
              {actorName ? (
                <>
                  {" "}
                  by <strong>{actorName}</strong>
                </>
              ) : null}
              . You are no longer on this plan&apos;s team.
            </>
          )}
        </Text>
      ) : null}

      {event === "WITHDRAWN" ? (
        <Text style={paragraph}>
          <strong>{who}</strong> is no longer on the team of{" "}
          <strong>{planTitle}</strong> (<strong>{roleLabel}</strong>).
        </Text>
      ) : null}

      {event === "EXPIRED" ? (
        <Text style={paragraph}>
          The <strong>{roleLabel}</strong> invitation for{" "}
          <strong>{planTitle}</strong> lapsed without a response.
        </Text>
      ) : null}

      {event === "EXPIRING_SOON" ? (
        <Text style={paragraph}>
          Your invitation to collaborate on <strong>{planTitle}</strong> as{" "}
          <strong>{roleLabel}</strong> lapses
          {expiresOn ? ` on ${expiresOn}` : " soon"}. Accept or decline before
          then.
        </Text>
      ) : null}

      {learner ? (
        <Text style={paragraph}>
          {cohostChangeSentence(event, collaboratorName ?? null, planTitle)}
        </Text>
      ) : null}

      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          {learner
            ? "Open your bookings"
            : event === "INVITED" ||
                event === "TERMS_CHANGED" ||
                event === "EXPIRING_SOON"
              ? "Review invitation"
              : "Open collaborations"}
        </Button>
      </Section>
    </EmailLayout>
  );
}
