"use client";

import { useEffect, useState } from "react";
import { cn } from "@/utils/tailwind";

export type ProfileSectionId =
  "about" | "sessions" | "programs" | "products" | "reviews";

const SECTIONS: readonly { id: ProfileSectionId; label: string }[] = [
  { id: "about", label: "About" },
  { id: "sessions", label: "Sessions" },
  { id: "programs", label: "Programs" },
  { id: "products", label: "Products" },
  { id: "reviews", label: "Reviews" },
];

/** Scroll offset that clears the fixed site header plus this bar. */
export const PROFILE_SECTION_SCROLL_MARGIN =
  "scroll-mt-[calc(var(--maintenance-banner-height,0px)+var(--header-height,5rem)+4rem)]";

/** How far past the anchor line still counts as having reached a section. */
const READING_LINE_SLACK_PX = 16;

/** Sticky in-page tabs for the sections that have content; the active one carries `aria-current`. */
export function ProfileAnchorTabs({
  present,
}: Readonly<{ present: Readonly<Record<ProfileSectionId, boolean>> }>) {
  const tabs = SECTIONS.filter(({ id }) => present[id]);
  const ids = tabs.map(({ id }) => id).join(",");
  const [active, setActive] = useState<ProfileSectionId>("about");

  useEffect(() => {
    const order = ids.split(",") as ProfileSectionId[];
    const visible = new Set<ProfileSectionId>();

    // Where an anchor click lands: the section's own scroll margin.
    const firstSectionReached = () => {
      const el = document.getElementById(order[0]);
      if (!el) return true;
      const line = Number.parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
      return el.getBoundingClientRect().top <= line + READING_LINE_SLACK_PX;
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id as ProfileSectionId;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        // On wide screens the Sessions panel is a sidebar beside About and is
        // in view from the first paint, while About sits lower. Until the
        // reader reaches the first section it stays the active tab.
        if (!firstSectionReached()) {
          setActive(order[0]);
          return;
        }
        const first = order.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      { rootMargin: "-25% 0px -60% 0px" },
    );
    for (const id of order) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [ids]);

  if (tabs.length < 2) return null;

  return (
    <nav
      aria-label="Profile sections"
      className="sticky top-[calc(var(--maintenance-banner-height,0px)+var(--header-height,5rem))] z-30 border-b border-border bg-card"
    >
      <ul className="flex w-full gap-1 overflow-x-auto px-4 md:px-8 lg:px-12">
        {tabs.map(({ id, label }) => (
          <li key={id} className="shrink-0">
            <a
              href={`#${id}`}
              aria-current={active === id ? "true" : undefined}
              onClick={() => setActive(id)}
              className={cn(
                "inline-block border-b-2 px-4 py-3 text-sm font-medium whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active === id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
