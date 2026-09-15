import * as React from "react";
import { Body, Container, Head, Html, Preview, Section } from "react-email";
import { getAppUrl } from "@/lib/url";
import { EmailFooter } from "./EmailFooter";
import { EmailLogo } from "./EmailLogo";
import { container, content, main } from "./styles";

interface EmailLayoutProps {
  /** The inbox preview line. */
  preview: string;
  /** From `EmailRecipient.unsubscribeUrl`; null for a required notice. */
  unsubscribeUrl?: string | null;
  /** A notice the reader cannot turn off: no unsubscribe or preferences links. */
  requiredNotice?: boolean;
  showSupport?: boolean;
  children: React.ReactNode;
}

// #1653 — the one frame every lifecycle template renders inside. Existing
// templates still hand-roll theirs; they are untouched.
export const EmailLayout = ({
  preview,
  unsubscribeUrl,
  requiredNotice = false,
  showSupport = false,
  children,
}: EmailLayoutProps) => (
  <Html>
    <Head />
    <Preview>{preview}</Preview>
    <Body style={main}>
      <Container style={container}>
        <EmailLogo />
        <Section style={content}>{children}</Section>
        <EmailFooter
          unsubscribeLink={unsubscribeUrl ?? undefined}
          preferencesLink={
            requiredNotice ? undefined : `${getAppUrl()}/profile`
          }
          requiredNotice={requiredNotice}
          showSupport={showSupport}
        />
      </Container>
    </Body>
  </Html>
);
