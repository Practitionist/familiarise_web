import * as React from "react";
import { Img, Section } from "react-email";
import { getAppUrl } from "@/lib/url";

// #1298 — absolute URL: a relative `../public/...` src is unreachable in mail.
const LOGO_SRC = `${getAppUrl()}/avif/static/assets/logos/images/logos/Familiarise-logos_transparent.avif`;

export const EmailLogo = () => (
  <Section>
    <Img src={LOGO_SRC} width="120" alt="Familiarise" style={logo} />
  </Section>
);

const logo = {
  margin: "0 auto",
  display: "block",
};
