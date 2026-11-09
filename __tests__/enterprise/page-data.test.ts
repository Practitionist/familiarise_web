import {
  enterpriseClosing,
  enterpriseHero,
} from "@/app/enterprise/_components/page-data";

const hero = {
  eyebrow: "e",
  titleLead: "l",
  titleAccent: "a",
  subtitle: "s",
  secondaryCta: { label: "More", href: "/enterprise" },
  assurances: ["x"],
  card: { title: "t", items: ["i"] },
};

describe("enterprise page data", () => {
  it("fills the brand line and the demo CTA on every hero", () => {
    const data = enterpriseHero(hero);
    expect(data.brandLine).toBe("Familiarise for business");
    expect(data.primaryCta).toEqual({
      label: "Book a demo",
      href: "/enterprise/demo",
    });
  });

  it("lets a page preselect a use case without changing the label", () => {
    const data = enterpriseHero({
      ...hero,
      demoHref: "/enterprise/demo?useCase=institution",
    });
    expect(data.primaryCta).toEqual({
      label: "Book a demo",
      href: "/enterprise/demo?useCase=institution",
    });
    expect("demoHref" in data).toBe(false);
  });

  it("gives every closing the demo CTA and the sales-assisted note", () => {
    const closing = enterpriseClosing({
      title: "t",
      description: "d",
      secondaryCta: { label: "More", href: "/enterprise" },
    });
    expect(closing.primaryCta.href).toBe("/enterprise/demo");
    expect(closing.reassurance).toMatch(/Sales-assisted/);
    expect("demoHref" in closing).toBe(false);
  });
});
