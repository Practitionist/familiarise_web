import { ImageResponse } from "next/og";

import type { EventPlanKind } from "@/lib/seo/event-plan-share";

export const SHARE_IMAGE_SIZE = { width: 1200, height: 630 };
export const SHARE_IMAGE_CONTENT_TYPE = "image/png";

/** Fresh enough that a renamed plan shows up soon, and a crawler burst renders once. */
const SHARE_IMAGE_CACHE_CONTROL =
  "public, max-age=300, s-maxage=300, stale-while-revalidate=600";

const MAX_TITLE_CHARS = 110;

/** Cut at a word boundary when one is near the end, so a title does not stop mid-word. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const lastSpace = head.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? head.slice(0, lastSpace) : head).trimEnd()}…`;
}

/**
 * The link-preview card for a webinar or class. It names the plan only when the
 * caller says an anonymous visitor may see it, and carries no price, date or
 * seats left: those change, and messaging apps cache a preview for days.
 */
export function renderEventPlanShareImage(params: {
  kind: EventPlanKind;
  title: string | null;
  host: string | null;
}): ImageResponse {
  const { kind, title, host } = params;
  const label = kind === "webinar" ? "LIVE WEBINAR" : "LIVE CLASS";
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 72,
        background: "#0f172a",
        color: "#ffffff",
      }}
    >
      <div
        style={{
          display: "flex",
          fontSize: 30,
          letterSpacing: 4,
          color: "#93c5fd",
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            fontSize: title && title.length > 60 ? 56 : 72,
            fontWeight: 700,
            lineHeight: 1.15,
          }}
        >
          {title ? clip(title, MAX_TITLE_CHARS) : "Live sessions with experts"}
        </div>
        {title && host ? (
          <div
            style={{
              display: "flex",
              marginTop: 28,
              fontSize: 34,
              color: "#cbd5e1",
            }}
          >
            {`with ${clip(host, 60)}`}
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", fontSize: 36, fontWeight: 700 }}>
        Familiarise
      </div>
    </div>,
    {
      ...SHARE_IMAGE_SIZE,
      headers: { "Cache-Control": SHARE_IMAGE_CACHE_CONTROL },
    },
  );
}
