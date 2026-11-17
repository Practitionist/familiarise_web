import type { ReactNode } from "react";

import { formatPerson, type PersonLike } from "@/lib/backoffice/person";
import { cn } from "@/utils/tailwind";

/**
 * A person in a back-office table: name, then email, then a muted id. The
 * hover title carries the full name and email, which a narrow card truncates.
 */
export function PersonCell({
  person,
  leading,
  anonymousLabel,
  suffix,
  className,
}: Readonly<{
  person: PersonLike | null | undefined;
  /** An avatar or icon drawn before the text. */
  leading?: ReactNode;
  /**
   * Set when the person is anonymous to the public: shown under the name, and
   * in place of "Removed user" when no name or email is known.
   */
  anonymousLabel?: string;
  /** Drawn after the name, e.g. "(you)". */
  suffix?: ReactNode;
  className?: string;
}>) {
  const label = formatPerson(person, { anonymousLabel });
  const title = [label.primary, label.secondary].filter(Boolean).join(" · ");
  return (
    <div
      className={cn("flex min-w-0 items-center gap-3", className)}
      title={title}
    >
      {leading}
      <div className="min-w-0">
        <p className="truncate font-medium text-foreground">
          {label.primary}
          {suffix && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {suffix}
            </span>
          )}
        </p>
        {label.secondary && (
          <p className="truncate text-sm text-muted-foreground">
            {label.secondary}
          </p>
        )}
        {label.anonymous && (
          <p className="truncate text-xs italic text-muted-foreground">
            {label.anonymous}
          </p>
        )}
        {label.id && (
          <p className="truncate font-mono text-[11px] text-muted-foreground/70">
            {label.id}
          </p>
        )}
      </div>
    </div>
  );
}
