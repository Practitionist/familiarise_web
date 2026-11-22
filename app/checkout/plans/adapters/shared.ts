import { useEffect } from "react";

import type { CheckoutSearchParams } from "../components/PlanCheckoutShell";
import { reportPaymentsError } from "../utils";

/** A stable string for a query key: the same URL always yields the same key. */
export function searchParamsKey(searchParams: CheckoutSearchParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, v);
    } else if (value !== undefined) {
      params.append(key, value);
    }
  }
  return params.toString();
}

/** The message a failed plan fetch shows in place of the page. */
export function loadErrorMessage(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error
    ? error.message
    : "An unexpected error occurred. Please try again.";
}

/** What a plan its reader may not open says; the checkout's error card keys its title and Browse experts link on it. */
export const PLAN_UNAVAILABLE_MESSAGE =
  "This plan isn't available to book right now. Browse other experts to find another.";

/** The plan read failed: a hidden or withdrawn plan is not bookable, never a raw status. */
export function planLoadError(status: number): Error {
  return new Error(
    status === 404
      ? PLAN_UNAVAILABLE_MESSAGE
      : "We couldn't load this checkout. Please try again.",
  );
}

/** Reads a checkout's plan by id; a plan its reader may not open reads as not bookable. */
export async function fetchCheckoutPlan<
  T extends {
    data?: { consultantProfile?: { user?: unknown } | null } | null;
  },
>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw planLoadError(response.status);
  const data: T = await response.json();
  if (!data.data?.consultantProfile?.user) {
    throw new Error("Consultant details not found");
  }
  return data;
}

/** Reports a failed plan read once per error. */
export function useReportPlanLoadError(error: unknown): void {
  useEffect(() => {
    if (error) {
      reportPaymentsError(error);
      console.error("Error fetching plan data:", error);
    }
  }, [error]);
}

/** The mock-pay failure copy webinars and classes share, worded for one noun. */
export function eventMockErrorCopy(words: {
  noun: "webinar" | "class";
  doneTitle: string;
  linkErrorTitle: string;
  action: string;
  incompleteNoun: string;
}) {
  const Noun = words.noun === "webinar" ? "Webinar" : "Class";
  return (error: Error): { title: string; description: string } => {
    if (error.message.includes(`Invalid ${words.noun} parameters`)) {
      return {
        title: words.linkErrorTitle,
        description: `The ${words.incompleteNoun} information is incomplete. Please go back to the ${words.noun} page and click '${words.action}' again to ensure all required information is included.`,
      };
    }
    if (error.message.includes(`${Noun} plan not found`)) {
      return {
        title: `${Noun} Not Found`,
        description: `This ${words.noun} could not be found or may no longer be available. Please go back and select a different ${words.noun}, or contact support if you believe this is an error.`,
      };
    }
    if (error.message.includes("network") || error.message.includes("fetch")) {
      return {
        title: "Connection Error",
        description:
          "Unable to connect to the server. Please check your internet connection and try again.",
      };
    }
    return {
      title: words.doneTitle,
      description: `${error.message}. Please try again or contact support if the problem persists.`,
    };
  };
}

/** The "Includes" lines: what the expert listed, then facts the plan's own fields state. */
export function planIncludes(
  whatsIncluded: readonly string[] | null | undefined,
  derived: ReadonlyArray<string | false | null | undefined>,
): string[] {
  const listed = (whatsIncluded ?? []).map((s) => s.trim()).filter(Boolean);
  return [...listed, ...derived.filter((s): s is string => !!s)];
}
