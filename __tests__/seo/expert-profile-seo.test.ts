import {
  expertProfileJsonLd,
  expertProfileMetadata,
  type ExpertSeoInput,
} from "@/lib/seo/expert-profile";

const expert: ExpertSeoInput = {
  id: "c1",
  headline: "Staff Engineer at Acme",
  description:
    "I help engineers prepare for system design interviews and grow into senior roles with a practical plan.",
  languages: ["English", "Hindi"],
  domain: { name: "Technology" },
  user: {
    name: "Asha Rao",
    image: "https://img/a.png",
    profileDisplayImage: null,
  },
};

describe("expert profile SEO", () => {
  it("titles the page with the expert, their headline and the site name", () => {
    expect(expertProfileMetadata(expert).title).toBe(
      "Asha Rao, Staff Engineer at Acme | Familiarise",
    );
  });

  it("canonicalises to the profile path and carries the photo", () => {
    const meta = expertProfileMetadata(expert);
    expect(meta.alternates?.canonical).toBe("/explore/experts/c1");
    expect(meta.openGraph).toMatchObject({
      type: "profile",
      images: [{ url: "https://img/a.png" }],
    });
  });

  it("prefers the display photo over the account image", () => {
    const meta = expertProfileMetadata({
      ...expert,
      user: { ...expert.user, profileDisplayImage: "https://img/display.png" },
    });
    expect(meta.openGraph).toMatchObject({
      images: [{ url: "https://img/display.png" }],
    });
  });

  it("falls back to a sentence built from the headline when the bio is empty", () => {
    const meta = expertProfileMetadata({ ...expert, description: "n/a" });
    expect(meta.description).toBe(
      "Book a session with Asha Rao, Staff Engineer at Acme, on Familiarise.",
    );
  });

  it("trims a long bio to one search-result line", () => {
    const meta = expertProfileMetadata({
      ...expert,
      description: "word ".repeat(100),
    });
    expect((meta.description ?? "").length).toBeLessThanOrEqual(155);
    expect(meta.description).toMatch(/…$/);
  });

  it("describes the person in a ProfilePage and omits empty fields", () => {
    const ld = expertProfileJsonLd(
      { ...expert, languages: [], user: { ...expert.user, image: null } },
      "https://familiarisenow.com",
    );
    expect(ld["@type"]).toBe("ProfilePage");
    expect(ld.url).toBe("https://familiarisenow.com/explore/experts/c1");
    expect(ld.mainEntity.jobTitle).toBe("Staff Engineer at Acme");
    expect(ld.mainEntity.knowsLanguage).toBeUndefined();
    expect(ld.mainEntity.image).toBeUndefined();
  });
});
