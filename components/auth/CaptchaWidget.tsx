"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { AUTH_ERROR_COPY } from "@/lib/labels/auth-errors";

/**
 * Cloudflare Turnstile, invisible / managed, with no npm dependency.
 *
 * ## Why no wrapper
 *
 * The dependency tree has no Turnstile package (`react-turnstile`,
 * `@marsidev/react-turnstile`, …), and adding one for a ~200-line wrapper is
 * not a trade worth making: the whole surface we need is `render`, `reset`
 * and `remove` off `window.turnstile`. `lib/labels/auth-errors.catalog.ts`
 * already carries the three sentences a failed challenge can produce
 * (`VERIFICATION_FAILED`, `MISSING_RESPONSE`, `CAPTCHA_SERVICE_UNAVAILABLE`),
 * so this file's only job is the lifecycle.
 *
 * The one real cost of hand-rolling is the CSP: `script-src` and `frame-src`
 * both need `https://challenges.cloudflare.com`. Reported, not edited —
 * `next.config.mjs` is not this component's to change.
 *
 * ## Invisible, managed
 *
 * `execution: "execute"` (managed) runs the challenge as soon as the widget
 * mounts, with no button to bind to, so `token` is normally already populated
 * by the time the customer presses Submit. `appearance: "interaction-only"`
 * hides the checkbox unless Turnstile decides the visitor needs to see it —
 * that is the "invisible" half. (`execution: "invoke"` would need a click
 * handler and a pre-built token, which is the other invisible mode and does
 * not fit a plain form.)
 *
 * ## The single-use problem, and why the API shape forbids forgetting it
 *
 * A Turnstile token is good for **one** verification. Sending the same token
 * twice is rejected as `timeout-or-duplicate`, and the customer sees the
 * generic "something went wrong" because the server cannot tell "wrong
 * answer" from "already spent". Forgetting the reset after a failed submit is
 * therefore not a cosmetic bug — it makes the form permanently unusable after
 * exactly one mistake, which is the moment retry is most likely.
 *
 * So `useCaptcha` does not expose the token as the only thing a form needs.
 * It exposes `submit()`, and `submit()` is the only sanctioned way to send a
 * protected request:
 *
 *   - it refuses to call the request at all when a token is required and
 *     absent (the `MISSING_RESPONSE` case, which is otherwise a silent 400);
 *   - it hands the token *to* the request as an argument, so a token read
 *     into a variable earlier can never be the one that goes out;
 *   - and it resets the widget in a `finally`, so the reset happens on
 *     success, on failure, and on a throw — the three cases a hand-written
 *     `reset()` call gets wrong in turn.
 *
 * `token` is still exported, for a caller that must attach it to a
 * non-`submit` call (a raw `fetch`, a test). `reset` is exported for the same
 * reason. A caller using the normal path cannot skip the reset, because the
 * normal path does not take a token argument at all.
 */

/* -------------------------------------------------------------------------- */
/* Turnstile, typed locally                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The subset of `window.turnstile` this component uses, declared here rather
 * than via a global `.d.ts` so the surface is auditable in one screen and no
 * global namespace is widened for every other module to depend on.
 */
interface TurnstileApi {
  render(
    container: HTMLElement | string,
    options: TurnstileRenderOptions,
  ): string | undefined;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

interface TurnstileRenderOptions {
  sitekey: string;
  /** Managed: run on mount. `invoke` would need a click to fire. */
  execution: "execute" | "invoke";
  /** Draw nothing until Turnstile decides the visitor must interact. */
  appearance: "always" | "execute" | "interaction-only";
  theme: "light" | "dark" | "auto";
  size: "normal" | "compact" | "flexible";
  callback: (token: string) => void;
  "error-callback": () => void;
  "expired-callback": () => void;
  "timeout-callback": () => void;
  retry?: "auto" | "never";
  language?: string;
  action?: string;
}

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function getTurnstile(): TurnstileApi | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile ?? null;
}

/**
 * One script tag per page, shared by every widget on it.
 *
 * The promise is module scope rather than a `useEffect` so two forms on one
 * page cannot race to insert two tags (Turnstile's `api.js` is not written to
 * be loaded twice, and the second load resets every widget already on screen —
 * which would silently void a token a customer had just earned).
 */
let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("turnstile requires a browser"));
  }
  const existing = getTurnstile();
  if (existing) return Promise.resolve(existing);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    // Turnstile's own recommendation: `data-cf-beacon` is how its support
    // tooling identifies the widget, and it is the documented hook for
    // "the script loaded but the global never appeared" (a blocked origin, a
    // proxy rewriting the response).
    script.dataset.cfTurnstile = "explicit";
    script.onload = () => {
      const api = getTurnstile();
      if (api) resolve(api);
      else
        reject(
          new Error(
            "turnstile script loaded without exposing window.turnstile",
          ),
        );
    };
    script.onerror = () => {
      // Allow a later mount to retry: a network blip on first paint should
      // not permanently disable the widget for the life of the page.
      scriptPromise = null;
      reject(new Error("turnstile script failed to load"));
    };
    document.head.appendChild(script);
  });

  return scriptPromise;
}

/* -------------------------------------------------------------------------- */
/* The hook                                                                    */
/* -------------------------------------------------------------------------- */

export interface CaptchaOptions {
  /**
   * Light or dark chrome. The auth pages render on `bg-neutral-950` (see the
   * `app/auth` sign-in / sign-up / forgot pages), so `dark` is the default;
   * the settings sections would pass `light`.
   */
  theme?: "light" | "dark" | "auto";
  /** Turnstile's `compact` size — the default here, matching a 100%-width card. */
  compact?: boolean;
  language?: string;
  /** Turnstile's analytics `action` label, e.g. `"signup"`. */
  action?: string;
}

export interface CaptchaContext {
  /** The current token, or `null`. */
  token: string | null;
  /** Spread into the request: `{ "x-captcha-response": token }`, empty if none. */
  headers: Record<string, string>;
}

export interface UseCaptchaResult extends CaptchaContext {
  /** False when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is unset — the whole feature is off. */
  enabled: boolean;
  /** Attach to the container that `<CaptchaWidget />` renders. */
  captchaRef: MutableRefObject<HTMLDivElement | null>;
  /**
   * The catalog sentence for a challenge that could not be completed, or
   * `null`. Never a raw error, for the same reason every other surface in
   * this app never shows one.
   */
  error: string | null;
  /** Invalidate the current token and ask Turnstile for a new one. */
  reset: () => void;
  /**
   * The only sanctioned way to send a captcha-protected request. See the
   * file header for why the reset cannot be forgotten.
   */
  submit: <T>(run: (captcha: CaptchaContext) => Promise<T>) => Promise<void>;
}

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

export function useCaptcha(options: CaptchaOptions = {}): UseCaptchaResult {
  const { theme = "dark", compact = true, language, action } = options;

  // Read once, at module scope: `NEXT_PUBLIC_*` is inlined at build time, so
  // it cannot change at runtime and re-reading it per render would be a lie.
  const enabled = !!SITE_KEY;

  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serviceDown, setServiceDown] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const captchaRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  // Stable for the life of the component — it reads a ref, never a prop or
  // state value — so it can be a direct dependency of `submit` and of the
  // retry timer without re-creating either.
  const reset = useCallback(() => {
    setToken(null);
    const id = widgetIdRef.current;
    if (id) getTurnstile()?.reset(id);
    // A failed submit is the moment the customer most wants a fresh
    // challenge, so clear the stale sentence with the stale token.
    setError(null);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (!captchaRef.current) return;

    let cancelled = false;

    loadTurnstile()
      .then((api) => {
        if (cancelled || !captchaRef.current) return;
        const widgetId = api.render(captchaRef.current, {
          sitekey: SITE_KEY as string,
          execution: "execute",
          appearance: "interaction-only",
          theme,
          size: compact ? "compact" : "normal",
          ...(language ? { language } : {}),
          ...(action ? { action } : {}),
          callback: (value: string) => {
            setToken(value);
            setError(null);
          },
          "error-callback": () => {
            setToken(null);
            setServiceDown(true);
            setError(AUTH_ERROR_COPY.CAPTCHA_SERVICE_UNAVAILABLE.description);
          },
          "expired-callback": () => {
            // The token aged out (Turnstile's default is 5 minutes). It is
            // still "ours" but no longer verifiable in the spirit the server
            // expects, so treat it as absent rather than sending it and
            // collecting a confusing refusal.
            setToken(null);
          },
          "timeout-callback": () => {
            setToken(null);
            setError(AUTH_ERROR_COPY.VERIFICATION_FAILED.description);
          },
        });
        widgetIdRef.current = widgetId ?? null;
        setServiceDown(false);
      })
      .catch(() => {
        if (cancelled) return;
        setServiceDown(true);
        setError(AUTH_ERROR_COPY.CAPTCHA_SERVICE_UNAVAILABLE.description);
      });

    return () => {
      cancelled = true;
      // `remove`, not `reset`: an unmounted widget must not keep a token
      // alive, and a re-mount needs a fresh widget id.
      if (widgetIdRef.current) getTurnstile()?.remove(widgetIdRef.current);
      widgetIdRef.current = null;
    };
    // `theme` / `compact` / `language` / `action` are render options, not
    // runtime inputs: a change has to re-render the widget, and the
    // callbacks above only touch stable setters, so none of them needs to
    // be a dependency. `reloadKey` is the retry lever — see below.
  }, [enabled, theme, compact, language, action, reloadKey]);

  // The service being down is recoverable without a page reload. Bumping
  // `reloadKey` re-runs the effect above, which tears the old widget down
  // and asks `loadTurnstile()` for a new one — and `loadTurnstile` has
  // already cleared its cached promise on failure, so this is a real second
  // attempt rather than the same rejected promise.
  useEffect(() => {
    if (!serviceDown) return;
    const timer = setTimeout(() => setReloadKey((n) => n + 1), 30_000);
    return () => clearTimeout(timer);
  }, [serviceDown]);

  const headers = useMemo<Record<string, string>>(
    () =>
      enabled && token
        ? { "x-captcha-response": token }
        : ({} as Record<string, string>),
    [enabled, token],
  );

  const submit = useCallback(
    async <T,>(run: (captcha: CaptchaContext) => Promise<T>) => {
      if (enabled && !token) {
        // The failure this catches is easy to miss otherwise: a managed
        // widget that has not answered yet, a challenge the customer
        // abandoned, a script still loading. Without this check the request
        // goes out with no header and comes back as an opaque 400.
        setError(AUTH_ERROR_COPY.MISSING_RESPONSE.description);
        reset();
        return;
      }
      try {
        await run({ token, headers });
      } finally {
        // Single-use. Success navigates away, failure needs a new token —
        // and the one case everyone forgets is the throw, which lands here
        // precisely because it is a `finally`.
        reset();
      }
    },
    [enabled, token, headers, reset],
  );

  return { enabled, token, headers, captchaRef, error, reset, submit };
}

/* -------------------------------------------------------------------------- */
/* The widget                                                                  */
/* -------------------------------------------------------------------------- */

export interface CaptchaWidgetProps {
  /** From `useCaptcha().captchaRef`. */
  widgetRef: MutableRefObject<HTMLDivElement | null>;
  /** `useCaptcha().error`, rendered under the container. */
  error?: string | null;
  className?: string;
}

/**
 * The container Turnstile renders into. Renders **nothing** when the site key
 * is unset, which is what keeps dev, CI, and every deploy made before the CSP
 * allow-list is widened completely unaffected by this file existing.
 *
 * The container is `min-h-[65px]` because `appearance: "interaction-only"`
 * collapses to nothing when no interaction is needed; without the floor the
 * card above it would jump once the checkbox decides to appear.
 */
export function CaptchaWidget({
  widgetRef,
  error,
  className = "",
}: Readonly<CaptchaWidgetProps>) {
  if (!SITE_KEY) return null;
  return (
    <div className={className}>
      <div
        ref={widgetRef}
        className="min-h-[65px]"
        data-testid="captcha-widget"
      />
      {error && (
        <p role="alert" className="mt-1 text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

export { SITE_KEY as TURNSTILE_SITE_KEY };
