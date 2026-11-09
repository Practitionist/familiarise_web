import type { Metadata } from "next";

export interface ExpertSeoInput {
  id: string;
  headline: string | null;
  description: string | null;
  languages: string[];
  domain: { name: string } | null;
  user: {
    name: string | null;
    image: string | null;
    profileDisplayImage: string | null;
  };
}

const DESCRIPTION_MAX = 155;

export function expertPath(id: string): string {
  return `/explore/experts/${id}`;
}

function expertImage(expert: ExpertSeoInput): string | null {
  return expert.user.profileDisplayImage ?? expert.user.image;
}

/** One line a search result can show: the expert's own words, else a plain sentence from their headline. */
function expertSummary(expert: ExpertSeoInput): string {
  const name = expert.user.name ?? "This expert";
  const own = expert.description?.replace(/\s+/g, " ").trim();
  if (own && own.length > 40) {
    return own.length > DESCRIPTION_MAX
      ? `${own.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`
      : own;
  }
  const focus = expert.headline ?? expert.domain?.name;
  return focus
    ? `Book a session with ${name}, ${focus}, on Familiarise.`
    : `Book a session with ${name} on Familiarise.`;
}

export function expertProfileMetadata(expert: ExpertSeoInput): Metadata {
  const name = expert.user.name ?? "Expert";
  const focus = expert.headline ?? expert.domain?.name;
  const heading = focus ? `${name}, ${focus}` : name;
  const title = `${heading} | Familiarise`;
  const description = expertSummary(expert);
  const image = expertImage(expert);
  return {
    title,
    description,
    alternates: { canonical: expertPath(expert.id) },
    openGraph: {
      type: "profile",
      title,
      description,
      url: expertPath(expert.id),
      ...(image ? { images: [{ url: image }] } : {}),
    },
  };
}

/** ProfilePage wrapping a Person; ratings are left out because Person does not carry aggregateRating. */
export function expertProfileJsonLd(expert: ExpertSeoInput, baseUrl: string) {
  const url = `${baseUrl}${expertPath(expert.id)}`;
  const image = expertImage(expert);
  return {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    url,
    mainEntity: {
      "@type": "Person",
      name: expert.user.name ?? undefined,
      url,
      jobTitle: expert.headline ?? undefined,
      description: expertSummary(expert),
      image: image ?? undefined,
      knowsLanguage: expert.languages.length > 0 ? expert.languages : undefined,
    },
  };
}
