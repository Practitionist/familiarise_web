/**
 * Inline notice surfaced wherever an enterprise permutation is selectable
 * but its end-to-end implementation is still in flight. Keeps the v1
 * grid honest without hiding the option from the UI: operators still
 * see the choice + know it's tracked.
 *
 * Each mount passes the GitHub issue numbers it's tracking so the user
 * can hop straight to the open work. The banner renders nothing if the
 * issues array is empty (defensive — caller might compute the list
 * conditionally).
 *
 * Why not hide the option outright? Per the 2026-04-27 readiness review
 * (#issuecomment-4324209819): hiding now risks forgetting to re-enable
 * later. WIP banners + linked issues are the agreed alternative. The
 * eventual sweep that drops every banner once the underlying work
 * ships is tracked in #730.
 */

import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export interface EnterpriseWipBannerProps {
  /** Headline shown in bold. Keep under 60 chars. */
  title: string;
  /** Sentence (or two) explaining what's not wired yet. */
  description: string;
  /** GitHub issue numbers this banner tracks. Rendered as links. */
  issues: number[];
  /** Optional repo override; defaults to the project's repo. */
  repo?: string;
}

const DEFAULT_REPO = "Practitionist/familiarise_web";

export function EnterpriseWipBanner({
  title,
  description,
  issues,
  repo = DEFAULT_REPO,
}: EnterpriseWipBannerProps) {
  if (issues.length === 0) return null;

  return (
    <Alert
      variant="default"
      className="border-amber-200 bg-amber-50 text-amber-900 [&>svg]:text-amber-700"
      role="status"
    >
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="text-amber-800">
        <p>{description}</p>
        <p className="mt-1 text-xs">
          Tracked in{" "}
          {issues.map((n, i) => (
            <span key={n}>
              <a
                href={`https://github.com/${repo}/issues/${n}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-medium"
              >
                #{n}
              </a>
              {i < issues.length - 1 ? ", " : ""}
            </span>
          ))}
          .
        </p>
      </AlertDescription>
    </Alert>
  );
}
