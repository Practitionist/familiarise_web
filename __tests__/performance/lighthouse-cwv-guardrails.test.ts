/**
 * @jest-environment node
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveDefaultTracesSampleRate } from "../../sentry.shared.config";

function readRepoFile(relPath: string): string {
  return readFileSync(path.join(process.cwd(), relPath), "utf8");
}

describe("Lighthouse CWV & Anti-Runaway Billing Guardrails", () => {
  it("renders HeroSection <h1> as a Server Component without Framer Motion or blur animate-blob repaints", () => {
    const src = readRepoFile("components/home/HeroSection.tsx");
    expect(src).toContain("<h1");
    expect(src).not.toContain("<motion.h1");
    expect(src).not.toContain("framer-motion");
    expect(src).not.toContain("animate-blob");
  });

  it("uses renderLazyImage instead of renderLCPImage in below-the-fold BenefitsSection", () => {
    const src = readRepoFile("components/home/BenefitsSection.tsx");
    expect(src).toContain("renderLazyImage(");
    expect(src).not.toContain("renderLCPImage(");
  });

  it("renders native lazy <img> in AvatarImage without Radix eager new Image() preloading", () => {
    const src = readRepoFile("components/ui/avatar.tsx");
    expect(src).toContain('loading = "lazy"');
    expect(src).toContain('decoding = "async"');
    expect(src).not.toContain("@radix-ui/react-avatar");
  });

  it("dynamically imports Sentry on interaction/idle in instrumentation-client.ts instead of bundling eagerly", () => {
    const src = readRepoFile("instrumentation-client.ts");
    expect(src).not.toMatch(/^import\s+.*from\s+["']@sentry\/nextjs["']/m);
    expect(src).not.toMatch(
      /^import\s+.*from\s+["']\.\/sentry\.shared\.config["']/m,
    );
    expect(src).toContain('import("./sentry.shared.config")');
    expect(src).toContain('import("@sentry/nextjs")');
  });

  it("includes all required remote image hostnames in next.config.mjs images.remotePatterns", () => {
    const cfg = readRepoFile("next.config.mjs");
    const requiredHostnames = [
      "lh3.googleusercontent.com",
      "*.supabase.co",
      "avatars.githubusercontent.com",
      "upload.wikimedia.org",
      "img.logo.dev",
      "cdn.jsdelivr.net",
      "picsum.photos",
      "fastly.picsum.photos",
      "images.unsplash.com",
      "plus.unsplash.com",
    ];
    for (const host of requiredHostnames) {
      expect(cfg).toContain(`hostname: "${host}"`);
    }
  });

  it("caps TestimonialsSection marquee duplication to 2x per row instead of 9x", () => {
    const src = readRepoFile("components/home/TestimonialsSection.tsx");
    expect(src).toContain("[...reviews, ...reviews]");
    expect(src).not.toContain(
      "[...displayReviews, ...displayReviews, ...displayReviews]",
    );
  });

  it("sets WCAG AA compliant --muted-foreground (40% lightness), static .silver-text, and .cv-auto in app/globals.css", () => {
    const css = readRepoFile("app/globals.css");
    expect(css).toContain("--muted-foreground: 0 0% 40%;");
    expect(css).toContain("content-visibility: auto;");
    expect(css).not.toContain("animation: silver-shimmer");
  });

  describe("resolveDefaultTracesSampleRate", () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origSentryEnv = process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT;
    const origOverride = process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE;

    afterEach(() => {
      Object.defineProperty(process.env, "NODE_ENV", {
        value: origNodeEnv,
        configurable: true,
        writable: true,
      });
      if (origSentryEnv === undefined) {
        delete process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT;
      } else {
        process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = origSentryEnv;
      }
      if (origOverride === undefined) {
        delete process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE;
      } else {
        process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE = origOverride;
      }
    });

    it("caps production and preview default trace sampling at 0.1 and non-prod at 0.2", () => {
      delete process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE;

      Object.defineProperty(process.env, "NODE_ENV", {
        value: "production",
        configurable: true,
        writable: true,
      });
      expect(resolveDefaultTracesSampleRate()).toBe(0.1);

      Object.defineProperty(process.env, "NODE_ENV", {
        value: "development",
        configurable: true,
        writable: true,
      });
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "preview";
      expect(resolveDefaultTracesSampleRate()).toBe(0.1);

      delete process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT;
      expect(resolveDefaultTracesSampleRate()).toBe(0.2);
    });

    it("honors NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE override when valid", () => {
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE = "0.05";
      expect(resolveDefaultTracesSampleRate()).toBe(0.05);
    });
  });
});
