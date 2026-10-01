import type { ReactNode } from "react";
import { cn } from "@/utils/tailwind";

export interface SectionProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** `card` sits on a bordered surface; `plain` is only the heading and flow. */
  variant?: "card" | "plain";
  children: ReactNode;
  className?: string;
  /** Pass through for `aria-labelledby` or in-page anchors. */
  id?: string;
}

/**
 * A titled block inside a page (#1527 §15). The title is an h2 styled as the
 * 11px uppercase section label from the type scale, so the page h1 stays the
 * only large heading.
 */
export function Section({
  title,
  description,
  actions,
  variant = "plain",
  children,
  className,
  id,
}: Readonly<SectionProps>) {
  const hasHead = Boolean(title || description || actions);
  return (
    <section
      id={id}
      className={cn(
        variant === "card" &&
          "rounded-xl border border-border bg-card p-4 shadow-elevation-1 sm:p-5",
        className,
      )}
    >
      {hasHead && (
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            {title && (
              <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {title}
              </h2>
            )}
            {description && (
              <p className="mt-1 text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {actions}
            </div>
          )}
        </div>
      )}
      {children}
    </section>
  );
}

export interface KeyValueItem {
  /** Plain text; it is also the row key, so keep labels unique per list. */
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}

/** Label/value facts as a `<dl>`: a 140px label column at sm+, stacked below. */
export function KeyValueList({
  items,
  className,
}: Readonly<{ items: KeyValueItem[]; className?: string }>) {
  return (
    <dl className={cn("divide-y divide-border text-sm", className)}>
      {items.map((item) => (
        <div
          key={item.label}
          className="grid gap-1 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[140px_1fr] sm:gap-4"
        >
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className="min-w-0 break-words text-foreground">
            {item.value}
            {item.hint && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {item.hint}
              </p>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
