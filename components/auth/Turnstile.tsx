"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() ?? "";
// Loaded from this exact URL: Cloudflare breaks proxied or cached copies.
const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
  "timeout-callback": () => void;
  appearance: "always" | "execute" | "interaction-only";
  "refresh-expired": "auto" | "manual" | "never";
  theme: "light" | "dark" | "auto";
  size: "normal" | "flexible" | "compact";
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptLoad: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptLoad ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("Turnstile script loaded without its API"));
    };
    script.onerror = () => {
      scriptLoad = null;
      script.remove();
      reject(new Error("Turnstile script failed to load"));
    };
    document.head.appendChild(script);
  });
  return scriptLoad;
}

type TurnstileStatus = "checking" | "ready" | "error";

export interface TurnstileHandle {
  /** False when no site key is configured; the server then checks nothing. */
  enabled: boolean;
  token: string | null;
  status: TurnstileStatus;
  /** Callback ref: the widget renders once its container is in the DOM. */
  containerRef: (node: HTMLDivElement | null) => void;
  /** Tokens are single-use: call after every submit, failed ones included. */
  reset: () => void;
}

/** One explicit-render Turnstile widget; spread `captchaHeaders(handle)` into the auth call. */
export function useTurnstile(): TurnstileHandle {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<TurnstileStatus>("checking");

  useEffect(() => {
    if (!SITE_KEY || !container) return;
    let cancelled = false;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled) return;
        widgetId.current = turnstile.render(container, {
          sitekey: SITE_KEY,
          callback: (issued) => {
            setToken(issued);
            setStatus("ready");
          },
          "expired-callback": () => setToken(null),
          "error-callback": () => {
            setToken(null);
            setStatus("error");
          },
          "timeout-callback": () => setToken(null),
          appearance: "interaction-only",
          "refresh-expired": "auto",
          theme: "dark",
          size: "flexible",
        });
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {
        window.turnstile.remove(widgetId.current);
      }
      widgetId.current = null;
    };
  }, [container]);

  const reset = useCallback(() => {
    setToken(null);
    setStatus("checking");
    if (widgetId.current && window.turnstile) {
      window.turnstile.reset(widgetId.current);
    }
  }, []);

  return {
    enabled: SITE_KEY !== "",
    token,
    status,
    containerRef: setContainer,
    reset,
  };
}

/** The header Better Auth's captcha plugin reads; empty when Turnstile is off. */
export function captchaHeaders(
  handle: TurnstileHandle,
): Record<string, string> {
  return handle.enabled && handle.token
    ? { "x-captcha-response": handle.token }
    : {};
}

/** True when the form should hold the request until the check has a token. */
export function awaitingCaptcha(handle: TurnstileHandle): boolean {
  return handle.enabled && !handle.token;
}

const STATUS_COPY: Record<TurnstileStatus, string> = {
  checking: "Checking your browser…",
  ready: "Security check complete.",
  error:
    "The security check could not load. A privacy extension or network filter may be blocking challenges.cloudflare.com.",
};

/** The widget plus a polite live region; renders nothing when Turnstile is off. */
export function TurnstileWidget({ handle }: { handle: TurnstileHandle }) {
  if (!handle.enabled) return null;
  return (
    <div className="mt-4 grid gap-1" aria-label="Security check" role="group">
      <div ref={handle.containerRef} />
      <p
        aria-live="polite"
        className={
          handle.status === "error"
            ? "text-xs text-red-400"
            : "text-xs text-zinc-400"
        }
      >
        {STATUS_COPY[handle.status]}
      </p>
    </div>
  );
}
