import type { ReactNode } from "react";

import { formatPerson, type PersonLike } from "@/lib/backoffice/person";
import { cn } from "@/utils/tailwind";

/** A person in a back-office table: name, then email, then a muted id. */
export function PersonCell({
  person,
  leading,
  className,
}: Readonly<{
  person: PersonLike | null | undefined;
  /** An avatar or icon drawn before the text. */
  leading?: ReactNode;
  className?: string;
}>) {
  const label = formatPerson(person);
  return (
    <div className={cn("flex min-w-0 items-center gap-3", className)}>
      {leading}
      <div className="min-w-0">
        <p className="truncate font-medium text-foreground">{label.primary}</p>
        {label.secondary && (
          <p className="truncate text-sm text-muted-foreground">
            {label.secondary}
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
