import * as React from "react";
import { Button, Link, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  link,
  paragraph,
} from "@/emails/components/styles";

export type RescheduleEmailOutcome =
  "PROPOSED" | "MOVED" | "DECLINED" | "WITHDRAWN" | "EXPIRED" | "RELEASED";

export interface AppointmentRescheduledEmailProps {
  outcome: RescheduleEmailOutcome;
  recipientName: string;
  appointmentType: string;
  /** Pre-formatted in the recipient's zone. */
  oldStartsAtText?: string;
  newStartsAtText?: string;
  proposedBy?: string;
  /** PROPOSED only; when absent the copy says "before it lapses". */
  respondByText?: string;
  /** MOVED by a host: the free full-refund leave ends then (recipient's zone). */
  leaveByText?: string;
  /** MOVED: the recipient already holds another session at the new time. */
  clash?: boolean;
  /** A series move: the listed sessions (at most ten, recipient's zone) and how many more moved. */
  moves?: { fromText: string; toText: string }[];
  moreMoves?: number;
  /** MOVED: the attendee's own signed .ics link, which replaces the entry they added. */
  calendarIcsUrl?: string | null;
  dashboardUrl: string;
  unsubscribeUrl?: string | null;
}

// #1653 — PROPOSED is the time-boxed P0; the other five share one short
// informational body, mirroring the in-app branching in lib/novu/templates/b2c.ts.
function informationalBody(props: AppointmentRescheduledEmailProps): string {
  const { outcome, appointmentType, oldStartsAtText, newStartsAtText } = props;
  const stays = oldStartsAtText ? `; it stays on ${oldStartsAtText}` : "";
  switch (outcome) {
    case "MOVED":
      return [
        `Your ${appointmentType} moved from ${oldStartsAtText ?? "its earlier time"} to ${newStartsAtText ?? "a new time"}.`,
        props.clash ? "You already have a session then." : "",
        props.leaveByText
          ? `Keep your seat — nothing to do. Can't make it? Leave with a full refund until ${props.leaveByText}.`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
    case "RELEASED":
      return `The ${appointmentType}${oldStartsAtText ? ` on ${oldStartsAtText}` : ""} was released. You will be told once a new time is set.`;
    case "DECLINED":
      return `The proposed new time for your ${appointmentType} was declined${stays}.`;
    // #1846 — nobody answered, so the original booking was restored.
    case "EXPIRED":
      return `The proposed new time for your ${appointmentType} expired, so your original time stands${oldStartsAtText ? `: ${oldStartsAtText}` : ""}.`;
    default:
      return `The proposed new time for your ${appointmentType} was withdrawn, so your original time stands${oldStartsAtText ? `: ${oldStartsAtText}` : ""}.`;
  }
}

const TITLES: Record<RescheduleEmailOutcome, (t: string) => string> = {
  PROPOSED: (t) => `New time proposed for your ${t}`,
  MOVED: (t) => `Your ${t} has moved`,
  RELEASED: (t) => `Your ${t} time was released`,
  DECLINED: (t) => `Proposed time declined for your ${t}`,
  WITHDRAWN: (t) => `Reschedule request withdrawn for your ${t}`,
  EXPIRED: (t) => `Your ${t} keeps its original time`,
};

export default function AppointmentRescheduledEmail(
  props: AppointmentRescheduledEmailProps,
) {
  const {
    outcome,
    recipientName,
    appointmentType,
    oldStartsAtText,
    newStartsAtText,
    proposedBy,
    respondByText,
    dashboardUrl,
    unsubscribeUrl,
  } = props;
  const title = TITLES[outcome](appointmentType);
  return (
    <EmailLayout preview={title} unsubscribeUrl={unsubscribeUrl}>
      <Text style={heading}>{title}</Text>
      <Text style={paragraph}>Hi {recipientName},</Text>
      {outcome === "PROPOSED" ? (
        <>
          <Text style={paragraph}>
            {proposedBy ?? "The other party"} proposed a new time for your{" "}
            {appointmentType}: <strong>{newStartsAtText}</strong> instead of{" "}
            {oldStartsAtText}.
          </Text>
          <Text style={paragraph}>
            Please accept or decline it{" "}
            {respondByText ? (
              <>
                by <strong>{respondByText}</strong>
              </>
            ) : (
              "before it lapses"
            )}
            . If nobody answers in time, the proposal lapses and the booking
            goes back to its original time.
          </Text>
        </>
      ) : outcome === "MOVED" && props.moves && props.moves.length > 1 ? (
        <>
          <Text style={paragraph}>
            These sessions of your {appointmentType} moved:
          </Text>
          {props.moves.map((move) => (
            <Text key={`${move.fromText}|${move.toText}`} style={paragraph}>
              {move.fromText} → <strong>{move.toText}</strong>
            </Text>
          ))}
          {props.moreMoves ? (
            <Text style={paragraph}>and {props.moreMoves} more.</Text>
          ) : null}
          <Text style={paragraph}>
            {[
              props.clash ? "You already have a session at a new time." : "",
              props.leaveByText
                ? `Keep your seat — nothing to do. Can't make it? Leave with a full refund until ${props.leaveByText}.`
                : "",
            ]
              .filter(Boolean)
              .join(" ") || "Nothing else changes."}
          </Text>
        </>
      ) : (
        <Text style={paragraph}>{informationalBody(props)}</Text>
      )}
      {outcome === "MOVED" && props.calendarIcsUrl ? (
        <Text style={paragraph}>
          Already added it to your calendar?{" "}
          <Link href={props.calendarIcsUrl} style={link}>
            Download the updated .ics file
          </Link>
          ; opening it replaces the old entry with the new time.
        </Text>
      ) : null}
      <Section style={buttonContainer}>
        <Button style={button} href={dashboardUrl}>
          {outcome === "PROPOSED" ? "Review the new time" : "View booking"}
        </Button>
      </Section>
    </EmailLayout>
  );
}
