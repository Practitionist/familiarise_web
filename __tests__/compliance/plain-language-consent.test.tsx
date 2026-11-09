/**
 * @jest-environment jsdom
 */

/**
 * The sign-up notice and the consent rows are read by people, not engineers:
 * no purpose code (`PRIMARY_PROCESSING`), no pseudonym token (`ust_`), no
 * statute citation (`§8(5)`) may reach the screen, and the legal links must be
 * visibly links that open in a new tab.
 */

import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { DataProtectionNotice } from "../../components/compliance/DataProtectionNotice";
import { SignupConsentCheckboxes } from "../../components/compliance/SignupConsentCheckboxes";
import { LegalLink } from "../../components/compliance/LegalLink";
import ConsulteeAgreementForm from "../../app/form/onboarding/components/ConsulteeAgreementForm";
import TermsAndPrivacyAgreement from "../../app/form/onboarding/components/TermsAndPrivacyAgreement";
import {
  ALL_PURPOSE_CODES,
  PURPOSE_CODE_META,
} from "../../lib/compliance/purpose-codes";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CODE_LIKE = /\b[A-Z]{3,}_[A-Z_]{3,}\b/;
const CITATION = /§|&sect;|\bRule \d|\bDPDP\b/;

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => createRoot(container).render(node));
  return container;
}

function expectPlainText(text: string) {
  expect(text).not.toMatch(CODE_LIKE);
  expect(text).not.toContain("ust_");
  expect(text).not.toMatch(CITATION);
}

describe("onboarding consent copy", () => {
  it.each([
    ["consultee notice", <DataProtectionNotice key="a" audience="consultee" />],
    [
      "consultant notice",
      <DataProtectionNotice key="b" audience="consultant" />,
    ],
    [
      "consultee agreement step",
      <ConsulteeAgreementForm
        key="c"
        onNext={jest.fn()}
        onBack={jest.fn()}
        formData={{}}
      />,
    ],
    [
      "consultant agreement block",
      <TermsAndPrivacyAgreement
        key="d"
        onTermsChange={jest.fn()}
        onPrivacyChange={jest.fn()}
        onMarketingChange={jest.fn()}
        termsChecked={false}
        privacyChecked={false}
        marketingChecked={false}
      />,
    ],
  ])("renders no code, token or citation in the %s", async (_name, node) => {
    const container = await render(node);
    expectPlainText(container.textContent ?? "");
    expect(container.querySelector("code")).toBeNull();
  });

  it("states the data collected, the purposes, the rights and the Board", async () => {
    const text = (await render(<DataProtectionNotice audience="consultee" />))
      .textContent;
    expect(text).toContain("How we use your information");
    expect(text).toContain("date of birth");
    expect(text).not.toMatch(/18 or older/);
    expect(text).toContain("GetStream");
    expect(text).toContain("Razorpay");
    expect(text).toContain("Familiarise Support");
    expect(text).toContain("Settings → Account");
    expect(text).toContain("Data Protection Board of India");
  });

  it("renders every purpose label and description a person can see in plain words", () => {
    expect(ALL_PURPOSE_CODES.length).toBeGreaterThan(0);
    for (const code of ALL_PURPOSE_CODES) {
      expectPlainText(PURPOSE_CODE_META[code].label);
      expectPlainText(PURPOSE_CODE_META[code].description);
    }
  });
});

describe("legal links", () => {
  it("are underlined, open in a new tab and say so to screen readers", async () => {
    const container = await render(
      <SignupConsentCheckboxes
        termsChecked={false}
        privacyChecked={false}
        marketingChecked={false}
        onTermsChange={jest.fn()}
        onPrivacyChange={jest.fn()}
        onMarketingChange={jest.fn()}
      />,
    );
    const links = Array.from(container.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/terms",
      "/privacy",
    ]);
    for (const link of links) {
      expect(link.className).toContain("underline");
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
      expect(link.querySelector(".sr-only")?.textContent).toContain(
        "opens in a new tab",
      );
    }
  });

  it("LegalLink does not use the body-text colour alone to signal a link", async () => {
    const container = await render(<LegalLink href="/x">x</LegalLink>);
    expect(container.querySelector("a")?.className).toContain("underline");
  });
});
