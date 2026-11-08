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
import {
  main,
  container,
  content,
  heading,
  paragraph,
} from "@/emails/components/styles";

interface NewsletterWelcomeEmailProps {
  name?: string | null;
  unsubscribeLink: string;
}

export const NewsletterWelcomeEmail = ({
  name,
  unsubscribeLink = `${getAppUrl()}/api/newsletter/unsubscribe`,
}: NewsletterWelcomeEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>Welcome to the Familiarise newsletter</Preview>
      <Section style={main}>
        <Container style={container}>
          <EmailLogo />
          <Section style={content}>
            <Text style={heading}>You are subscribed</Text>
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

const inlineLink = {
  color: "#000",
  fontSize: "16px",
  textDecoration: "underline",
};
