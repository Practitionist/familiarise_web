"use client";

import { useEffect } from "react";

/**
 * Locks document scroll for the entire `/dashboard/*` tree.
 *
 * Role shells already use `h-screen-maintenance overflow-hidden` with an
 * inner `<main overflow-y-auto>`, but they sit inside the root layout's
 * `body.flex.flex-col.min-h-screen > .flex-1` wrapper. That wrapper (and
 * the body) stay `overflow: visible`, so anything that pushes document
 * height — flex min-content, banner padding vs 100dvh mismatch, fixed
 * chrome siblings — lets the window scroll past the grey shell into empty
 * body white space. Clipping the shell is not enough; the document itself
 * must not be a scrollport on dashboard routes.
 *
 * Marketing / auth pages are unaffected: this mounts only under
 * `app/dashboard/layout.tsx` and removes the class on leave.
 */
export function DashboardScrollLock() {
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("dashboard-scroll-locked");
    return () => {
      html.classList.remove("dashboard-scroll-locked");
    };
  }, []);

  return null;
}
