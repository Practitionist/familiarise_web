import type { ReactNode } from "react";

/** A legal document link: underlined so it reads as a link on dark and light themes, and opens in a new tab. */
export function LegalLink({
  href,
  children,
}: Readonly<{ href: string; children: ReactNode }>) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-foreground underline underline-offset-4 decoration-1 hover:decoration-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
