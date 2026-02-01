"use client";

import { usePathname } from "next/navigation";

/**
 * HeaderSpacer - Creates vertical space to account for fixed Navbar and AnnouncementBar
 *
 * This component prevents page content from being hidden behind the fixed header elements.
 * It uses CSS custom properties (--header-height) set dynamically by the AnnouncementBarProvider
 * and responsive media queries in globals.css, so it adapts automatically to:
 * - Different screen sizes (mobile, tablet, desktop)
 * - Orientation changes (portrait, landscape)
 * - Announcement bar visibility (present, dismissed, wrapping text)
 * - Device safe areas (notch, Dynamic Island)
 *
 * Excludes:
 * - Pages with transparent navbar overlay (home, explore/experts, etc.)
 * - Pages that exclude navbar entirely (checkout, dashboard, meetings, etc.)
 */
const HeaderSpacer = () => {
  const pathname = usePathname();

  // Routes that don't need the spacer (hero sections, excluded navbar routes)
  const excludedRoutes = [
    "/", // Home page (has full-bleed hero)
    "/explore/experts", // Experts page (has dark hero section)
    "/explore/programs", // Programs page (has dark hero section)
    "/explore/community", // Community page (has dark hero section)
  ];

  // Routes that never show navbar (so no spacer needed)
  const noNavbarRoutes = [
    "/api/",
    "/auth/",
    "/form/",
    "/checkout/",
    "/dashboard",
    "/meetings/",
  ];

  // Check if current route should exclude spacer
  const shouldExclude =
    excludedRoutes.includes(pathname) ||
    noNavbarRoutes.some((route) => pathname.startsWith(route));

  if (shouldExclude) {
    return null;
  }

  return (
    <div
      className="w-full"
      style={{ height: "var(--header-height)" }}
      aria-hidden="true"
    />
  );
};

export default HeaderSpacer;
