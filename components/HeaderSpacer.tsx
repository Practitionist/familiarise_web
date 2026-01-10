"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * HeaderSpacer - Creates vertical space to account for fixed Navbar and AnnouncementBar
 * 
 * This component prevents page content from being hidden behind the fixed header elements.
 * It dynamically adjusts based on whether the announcement bar is visible.
 * 
 * Heights:
 * - Navbar: h-16 (64px) mobile, h-20 (80px) desktop
 * - AnnouncementBar: ~42px
 * 
 * Excludes:
 * - Pages with transparent navbar overlay (home, explore/experts)
 * - Pages that exclude navbar entirely (checkout, dashboard, meetings, etc.)
 */
const HeaderSpacer = () => {
    const pathname = usePathname();
    const [isAnnouncementVisible, setIsAnnouncementVisible] = useState(true);

    useEffect(() => {
        const checkAnnouncementState = () => {
            const isClosed = localStorage.getItem("announcementBarClosed") === "true";
            setIsAnnouncementVisible(!isClosed);
        };

        checkAnnouncementState();

        // Listen for storage changes (cross-tab)
        window.addEventListener("storage", checkAnnouncementState);
        // Listen for custom event (same-window close)
        window.addEventListener("announcementBarClosed", checkAnnouncementState);

        return () => {
            window.removeEventListener("storage", checkAnnouncementState);
            window.removeEventListener("announcementBarClosed", checkAnnouncementState);
        };
    }, []);

    // Routes that don't need the spacer (hero sections, excluded navbar routes)
    const excludedRoutes = [
        "/",                    // Home page (has full-bleed hero)
        "/explore/experts",     // Experts page (has dark hero section)
        "/explore/programs",    // Programs page (has dark hero section)
        "/explore/community",   // Community page (has dark hero section)
    ];

    // Routes that never show navbar (so no spacer needed)
    const noNavbarRoutes = [
        "/api/",
        "/auth/",
        "/form/",
        "/checkout/",
        "/dashboard",  // Exact match for redirect page
        "/meetings/",
    ];

    // Check if current route should exclude spacer
    const shouldExclude =
        excludedRoutes.includes(pathname) ||
        noNavbarRoutes.some(route => pathname === route || pathname.startsWith(route + "/"));

    if (shouldExclude) {
        return null;
    }

    // Height: navbar (64px mobile / 80px desktop) + announcement bar (42px if visible)
    return (
        <div
            className={`w-full ${isAnnouncementVisible
                ? "h-[106px] md:h-[122px]" // 42 + 64 = 106, 42 + 80 = 122
                : "h-16 md:h-20"           // just navbar height
                }`}
            aria-hidden="true"
        />
    );
};

export default HeaderSpacer;
