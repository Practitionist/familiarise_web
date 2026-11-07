import * as React from "react";
import { Section, Text } from "react-email";
import { BRAND_COLOR_HEX, BRAND_NAME } from "@/lib/brand";
import { main } from "./styles";

// Text, not an image: it renders with images blocked and costs no request.
export const EmailLogo = () => (
  <Section>
    <Text style={wordmark}>{BRAND_NAME}</Text>
  </Section>
);

const wordmark = {
  margin: "8px 0 20px",
  textAlign: "center" as const,
  fontFamily: main.fontFamily,
  fontSize: "26px",
  fontWeight: "700",
  lineHeight: "32px",
  letterSpacing: "-0.5px",
  color: BRAND_COLOR_HEX,
};
