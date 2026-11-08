import {
  Button,
  Container,
  Head,
  Html,
  Preview,
  Section,
  Text,
} from "react-email";
import * as React from "react";
import { getAppUrl } from "@/lib/url";
import { EmailFooter } from "@/emails/components/EmailFooter";
import { EmailLogo } from "@/emails/components/EmailLogo";
import {
  main,
  container,
  content,
  heading,
  paragraph,
  buttonContainer,
  button,
} from "@/emails/components/styles";

interface NewsletterConfirmEmailProps {
  name?: string | null;
  confirmLink: string;
}

export const NewsletterConfirmEmail = ({
  name,
  confirmLink = `${getAppUrl()}/api/newsletter/confirm`,
}: NewsletterConfirmEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>Confirm your Familiarise newsletter subscription</Preview>
      <Section style={main}>
        <Container style={container}>
          <EmailLogo />
          <Section style={content}>
            <Text style={heading}>One click to confirm</Text>
            <Text style={paragraph}>Hi{name ? ` ${name}` : ""},</Text>
            <Text style={paragraph}>
              You asked to subscribe to the Familiarise newsletter. Confirm that
              this is your email address and we will send you product news and
              launch updates. Every email has an unsubscribe link.
            </Text>
            <Section style={buttonContainer}>
              <Button style={button} href={confirmLink}>
                Confirm subscription
              </Button>
            </Section>
            <Text style={paragraph}>
              This link is valid for the next 48 hours. If you did not sign up,
              you can safely ignore this email — we will not add you to anything
              until you click.
            </Text>
          </Section>
          <EmailFooter />
        </Container>
      </Section>
    </Html>
  );
};
