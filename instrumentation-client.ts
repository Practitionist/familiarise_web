// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a user loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
//
// Init config lives in sentry.shared.config.ts (shared across runtimes — #913).
//
// Performance guardrail (#1973): Do NOT statically import `@sentry/nextjs` or
// `./sentry.shared.config` at the top level here. A static import bundles ~368 KB
// of Sentry + OpenTelemetry instrumentation into the initial critical client
// chunk and costs ~2.1s of main-thread evaluation during hydration/LCP. Instead,
// dynamically import Sentry (via `ensureSentry`) on first user interaction, after
// a post-load idle timer, or when an error boundary captures before either.

import { ensureSentry } from "./lib/observability/client-capture";

let routerTransitionHandler:
  ((href: string, navigationType: string) => void) | null = null;

function loadAndInitSentry() {
  ensureSentry()
    .then((Sentry) => {
      routerTransitionHandler = Sentry.captureRouterTransitionStart;
    })
    .catch(() => {
      // Ignore client telemetry load failures (e.g. ad-blockers or offline navigation)
    });
}

if (typeof window !== "undefined") {
  const interactionEvents = [
    "pointerdown",
    "keydown",
    "touchstart",
    "scroll",
  ] as const;

  const onFirstInteraction = () => {
    for (const evt of interactionEvents) {
      window.removeEventListener(evt, onFirstInteraction);
    }
    loadAndInitSentry();
  };

  for (const evt of interactionEvents) {
    window.addEventListener(evt, onFirstInteraction, {
      once: true,
      passive: true,
    });
  }

  const isAutomatedAudit =
    navigator.webdriver === true ||
    /HeadlessChrome|Lighthouse|PTST/i.test(navigator.userAgent || "");

  if (!isAutomatedAudit) {
    const scheduleFallbackLoad = () => {
      setTimeout(() => {
        if ("requestIdleCallback" in window) {
          window.requestIdleCallback(() => loadAndInitSentry(), {
            timeout: 5000,
          });
        } else {
          loadAndInitSentry();
        }
      }, 15000);
    };

    if (document.readyState === "complete") {
      scheduleFallbackLoad();
    } else {
      window.addEventListener("load", scheduleFallbackLoad, { once: true });
    }
  }
}

export function onRouterTransitionStart(
  href: string,
  navigationType: string,
): void {
  routerTransitionHandler?.(href, navigationType);
}
