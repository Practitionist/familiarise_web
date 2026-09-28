"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { AuthErrorAction } from "@/lib/labels/auth-errors";

/**
 * How a page services one of the catalog's `AuthErrorAction`s.
 *
 * The point of the type is that the *page* declares what it can do, not the
 * component. A page that has nowhere to send "switch to SSO" returns
 * `undefined` for that action and this component renders nothing — which is
 * strictly better than rendering a button that navigates somewhere useless,
 * and strictly better than hardcoding one affordance per failure (the
 * pre-catalog shape, where "Forgot password?" was written into the sign-in
 * template whether or not the failure was a password failure).
 */
export type AuthActionTarget =
  | { kind: "link"; href: string }
  | { kind: "callback"; onClick: () => void; disabled?: boolean };

/**
 * The button/link text for each action.
 *
 * These are affordance labels, not error copy: `AUTH_ERROR_COPY` owns the
 * sentences (title + description) and this table owns what the button *says*.
 * Keeping them apart is what lets the catalog stay translatable on its own.
 *
 * `retry` is deliberately absent, and a resolver cannot return it. Turnstile-
 * style "just try again" as a *button* invites a second click on a request
 * that already failed — on sign-in that is precisely the behaviour a lockout
 * and a limiter exist to interrupt, and the submit button is always on screen
 * anyway. `retry` therefore means "the button you just pressed is the retry".
 */
export const AUTH_ERROR_ACTION_LABEL: Record<
  Exclude<AuthErrorAction, "retry">,
  string
> = {
  "forgot-password": "Forgot password?",
  "resend-verification": "Resend verification email",
  "request-new-link": "Get a new link",
  "switch-to-sso": "Use your organisation's sign-in",
  "sign-in": "Sign in",
  "sign-up": "Sign up",
  "contact-support": "Contact support",
  "enroll-2fa": "Set up two-factor authentication",
  "upgrade-plan": "Upgrade plan",
};

export interface AuthErrorAffordanceProps {
  /** From `AuthErrorCopy.action`. Absent when the failure has no next step. */
  action?: AuthErrorAction;
  /** The page's answer for that action; `undefined` renders nothing. */
  target?: AuthActionTarget;
  className?: string;
}

/**
 * Renders the one thing a failure asks the customer to do next.
 *
 * Colourless on purpose — it inherits `currentColor` and a `text-sm` scale, so
 * the same component is legible on the dark `bg-neutral-950` auth cards and on
 * the light `bg-background` settings sections without a `tone` prop guessing
 * which one it landed in.
 */
export function AuthErrorAffordance({
  action,
  target,
  className = "mt-2 text-sm font-medium underline-offset-4 hover:underline",
}: Readonly<AuthErrorAffordanceProps>) {
  if (!action || !target) return null;
  if (action === "retry") return null;

  const label = AUTH_ERROR_ACTION_LABEL[action];
  if (!label) return null;

  if (target.kind === "link") {
    return (
      <Link href={target.href} className={className}>
        {label}
      </Link>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={target.onClick}
      disabled={target.disabled}
      className={className}
    >
      {label}
    </Button>
  );
}
