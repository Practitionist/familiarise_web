import { Button, Section, Text } from "react-email";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";
import type { ClawbackNoticeEvent } from "@/lib/payments/payouts/clawback-notifications";

export const CLAWBACK_NOTICE_COPY: Record<
  ClawbackNoticeEvent,
  { title: string; description: string }
> = {
  RAISED: {
    title: "Payout adjustment recorded",
    description:
      "A refund or chargeback created an amount owed back from a previous payout. It can be offset against eligible future payouts. This notice does not mean your bank account was debited.",
  },
  OFFSET_RESERVED: {
    title: "Payout offset reserved",
    description:
      "This amount has been reserved from a payout being prepared to reduce an earlier adjustment. The payout has not been confirmed as completed. The offset is released if that payout fails, is cancelled or is reversed.",
  },
  OFFSET_RELEASED: {
    title: "Payout offset released",
    description:
      "The collecting payout did not complete, so this offset was released. The amount remains owed and can be offset against a later eligible payout.",
  },
  VOIDED: {
    title: "Payout adjustment reduced",
    description:
      "The receiving bank reversed the originating payout. This unrecovered part of its adjustment was removed to avoid deducting it twice. Previously recovered amounts remain accounted for.",
  },
};

export function ClawbackNoticeEmail(props: {
  recipientName: string;
  event: ClawbackNoticeEvent;
  amountText: string;
  payoutId: string;
  dashboardUrl: string;
  unsubscribeUrl?: string | null;
}) {
  const copy = CLAWBACK_NOTICE_COPY[props.event];
  return (
    <EmailLayout
      preview={copy.title}
      unsubscribeUrl={props.unsubscribeUrl}
      showSupport
    >
      <Text style={heading}>{copy.title}</Text>
      <Text style={paragraph}>Hi {props.recipientName},</Text>
      <Text style={paragraph}>{copy.description}</Text>
      <Text style={paragraph}>
        Adjustment amount: <strong>{props.amountText}</strong>. Payout
        reference: <strong>{props.payoutId}</strong>.
      </Text>
      <Section style={buttonContainer}>
        <Button style={button} href={props.dashboardUrl}>
          View payouts
        </Button>
      </Section>
    </EmailLayout>
  );
}
