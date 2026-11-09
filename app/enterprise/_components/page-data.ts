import type { EnterpriseCta, EnterpriseHeroData } from "./EnterpriseSections";

const BOOK_DEMO: EnterpriseCta = {
  label: "Book a demo",
  href: "/enterprise/demo",
};

const SALES_ASSISTED_NOTE =
  "Sales-assisted setup for Indian organisations on INR.";

type HeroInput = Omit<EnterpriseHeroData, "brandLine" | "primaryCta"> & {
  /** Overrides the demo link, e.g. to preselect a use case. */
  demoHref?: string;
};

/** The hero every "For business" page shares: brand line and the demo CTA come from here. */
export function enterpriseHero({
  demoHref,
  ...hero
}: HeroInput): EnterpriseHeroData {
  return {
    ...hero,
    brandLine: "Familiarise for business",
    primaryCta: { ...BOOK_DEMO, href: demoHref ?? BOOK_DEMO.href },
  };
}

interface ClosingInput {
  title: string;
  description: string;
  secondaryCta: EnterpriseCta;
  demoHref?: string;
}

export function enterpriseClosing({ demoHref, ...closing }: ClosingInput) {
  return {
    ...closing,
    primaryCta: { ...BOOK_DEMO, href: demoHref ?? BOOK_DEMO.href },
    reassurance: SALES_ASSISTED_NOTE,
  };
}
