import type { Metadata } from "next";

export type EventPlanKind = "webinar" | "class";

type SharePlan = {
  id: string;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  consultantProfile?: { user?: { name?: string | null } | null } | null;
};

const PATH_SEGMENT: Record<EventPlanKind, string> = {
  webinar: "webinars",
  class: "classes",
};

/** The public path of a plan's detail page, also its canonical URL. */
export function eventPlanPath(kind: EventPlanKind, planId: string): string {
  return `/explore/programs/plans/${PATH_SEGMENT[kind]}/${planId}`;
}

/** The text a link preview shows: the subtitle, else the opening of the description. */
function previewDescription(plan: SharePlan, kind: EventPlanKind): string {
  const text = (plan.subtitle ?? plan.description ?? "")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (text) return text.length > 155 ? `${text.slice(0, 154)}…` : text;
  return `A live ${kind} on Familiarise. Pay in INR and join over built-in video.`;
}

/**
 * Tab title, description and link-preview tags for a plan page the viewer may
 * see. The preview image is the segment's `opengraph-image`, which Next adds.
 * No schema.org Event markup: Google does not support online-only events.
 */
export function eventPlanMetadata(
  plan: SharePlan,
  kind: EventPlanKind,
): Metadata {
  const host = plan.consultantProfile?.user?.name;
  const withHost = host ? ` with ${host}` : "";
  const title = `${plan.title}${withHost} — Familiarise`;
  const description = previewDescription(plan, kind);
  const path = eventPlanPath(kind, plan.id);
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title,
      description,
      type: "website",
      url: path,
      siteName: "Familiarise",
      locale: "en_IN",
    },
    twitter: { card: "summary_large_image", title, description },
  };
}

/** For a missing or hidden plan of any kind: the page's own 404 title, and not for the index. */
export function hiddenPlanMetadata(): Metadata {
  return {
    title: "Page not found",
    robots: { index: false, follow: false },
  };
}
