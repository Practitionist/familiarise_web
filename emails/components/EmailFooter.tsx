import * as React from "react";
import { Link, Section, Text } from "react-email";
import { getAppUrl } from "@/lib/url";
import { companyPostalAddress, supportEmail } from "@/lib/email/config";

interface EmailFooterProps {
  /** Newsletter mail only: renders an "Unsubscribe" link first. */
  unsubscribeLink?: string;
  /** Adds a "Questions?" line pointing at the support mailbox. */
  showSupport?: boolean;
}

// #1298 — one footer for every template; the fake postal address is gone and
// the real one is rendered only when NEXT_PUBLIC_COMPANY_POSTAL_ADDRESS is set.
export const EmailFooter = ({
  unsubscribeLink,
  showSupport = false,
}: EmailFooterProps) => {
  const appUrl = getAppUrl();
  const postalAddress = companyPostalAddress();
  const support = supportEmail();
  return (
    <Section style={footer}>
      <Text style={footerText}>
        © {new Date().getFullYear()} Familiarise, All Rights Reserved
      </Text>
      {postalAddress && <Text style={footerText}>{postalAddress}</Text>}
      {showSupport && (
        <Text style={footerText}>
          Questions?{" "}
          <Link href={`mailto:${support}`} style={link}>
            {support}
          </Link>
        </Text>
      )}
      <Text style={footerLinks}>
        {unsubscribeLink && (
          <>
            <Link href={unsubscribeLink} style={link}>
              Unsubscribe
            </Link>{" "}
            •{" "}
          </>
        )}
        <Link href={`${appUrl}/privacy`} style={link}>
          Privacy Policy
        </Link>{" "}
        •{" "}
        <Link href={`${appUrl}/terms`} style={link}>
          Terms of Service
        </Link>
      </Text>
    </Section>
  );
};

const footer = {
  textAlign: "center" as const,
  margin: "20px 0",
};

const footerText = {
  fontSize: "12px",
  color: "#666",
  margin: "10px 0",
  lineHeight: "1.5",
};

const footerLinks = {
  fontSize: "12px",
  color: "#666",
  margin: "10px 0",
  lineHeight: "1.5",
};

const link = {
  color: "#666",
  textDecoration: "underline",
};
