import type { ReactNode } from "react";

/** "Open" is a plain new-tab link to the same-origin viewer; the current tab never navigates. */
export function FileOpenLink({
  href,
  className,
  children,
}: Readonly<{ href: string; className?: string; children: ReactNode }>) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
