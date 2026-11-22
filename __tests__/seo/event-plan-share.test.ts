/**
 * @jest-environment node
 */

import {
  eventPlanMetadata,
  eventPlanPath,
  hiddenPlanMetadata,
} from "@/lib/seo/event-plan-share";

const plan = {
  id: "wp-1",
  title: "5-Day LLD Bootcamp",
  subtitle: null,
  description: "  Design   real systems\n in five evenings.  ",
  consultantProfile: { user: { name: "Arun" } },
};

describe("eventPlanMetadata", () => {
  it("titles the tab with the host and sets a canonical URL on the plan path", () => {
    const meta = eventPlanMetadata(plan, "webinar");
    expect(meta.title).toBe("5-Day LLD Bootcamp with Arun — Familiarise");
    expect(meta.alternates?.canonical).toBe(
      "/explore/programs/plans/webinars/wp-1",
    );
    expect(eventPlanPath("class", "cp-9")).toBe(
      "/explore/programs/plans/classes/cp-9",
    );
  });

  it("prefers the subtitle, else the description with its whitespace collapsed", () => {
    expect(
      eventPlanMetadata(
        { ...plan, subtitle: "Five evenings, one system." },
        "webinar",
      ).description,
    ).toBe("Five evenings, one system.");
    expect(eventPlanMetadata(plan, "webinar").description).toBe(
      "Design real systems in five evenings.",
    );
  });

  it("cuts a long description to 155 characters and falls back when there is none", () => {
    const long = eventPlanMetadata(
      { ...plan, description: "x".repeat(400) },
      "class",
    );
    expect(String(long.description)).toHaveLength(155);
    const none = eventPlanMetadata(
      { ...plan, description: null, subtitle: null },
      "class",
    );
    expect(none.description).toMatch(/live class on Familiarise/i);
  });

  it("repeats the title in the Open Graph and Twitter tags, without an Event type", () => {
    const meta = eventPlanMetadata(plan, "webinar");
    expect(meta.openGraph).toMatchObject({
      title: meta.title,
      type: "website",
      url: "/explore/programs/plans/webinars/wp-1",
    });
    expect(meta.twitter).toMatchObject({ card: "summary_large_image" });
  });
});

describe("hiddenPlanMetadata", () => {
  it("titles the tab as the page's own 404 and asks to stay out of the index", () => {
    const meta = hiddenPlanMetadata();
    expect(meta.title).toBe("Page not found");
    expect(meta.robots).toEqual({ index: false, follow: false });
  });
});
