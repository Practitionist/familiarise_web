import {
  Container,
  Head,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "react-email";
import * as React from "react";
import { getAppUrl } from "@/lib/url";
import { EmailFooter } from "@/emails/components/EmailFooter";
import { EmailLogo } from "@/emails/components/EmailLogo";

interface WaitlistWelcomeEmailProps {
  name?: string | null;
  unsubscribeLink: string;
}

export const WaitlistWelcomeEmail = ({
  name,
  unsubscribeLink = `${getAppUrl()}/api/waitlist/unsubscribe`,
}: WaitlistWelcomeEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>You are on the Familiarise waitlist</Preview>
      <Section style={main}>
        <Container style={container}>
          <EmailLogo />
          <Section style={content}>
            <Text style={heading}>You are on the list</Text>
            <Text style={paragraph}>Hi{name ? ` ${name}` : ""},</Text>
            <Text style={paragraph}>
              Thanks for confirming. You will hear from us when there is
              something genuinely worth your attention — new experts joining the
              platform, programs opening up, and the occasional note on what we
              are building. No noise.
            </Text>
            <Text style={paragraph}>
              In the meantime, you can browse who is already on Familiarise.
            </Text>
            <Text style={paragraph}>
              <Link href={`${getAppUrl()}/explore/experts`} style={inlineLink}>
                Explore experts
              </Link>
            </Text>
          </Section>
          <EmailFooter unsubscribeLink={unsubscribeLink} />
        </Container>
      </Section>
    </Html>
  );
};

// Styles
const main = {
  backgroundColor: "#f5f5f5",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif',
};

const container = {
  margin: "0 auto",
  padding: "20px 0",
  maxWidth: "600px",
};

const content = {
  backgroundColor: "#ffffff",
  padding: "30px",
  borderRadius: "5px",
};

const heading = {
  fontSize: "28px",
  fontWeight: "bold",
  color: "#333",
  lineHeight: "1.3",
  margin: "0 0 20px",
};

const paragraph = {
  fontSize: "16px",
  lineHeight: "1.5",
  color: "#444",
  margin: "0 0 20px",
};

const inlineLink = {
  color: "#000",
  fontSize: "16px",
  textDecoration: "underline",
};
