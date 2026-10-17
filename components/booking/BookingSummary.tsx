import type { ReactNode } from "react";

export function BookingSummary({
  title,
  price,
  unit,
  children,
}: Readonly<{
  title: string;
  price: string;
  unit?: string;
  children: ReactNode;
}>) {
  return (
    <section aria-label="Booking summary" className="booking-summary">
      <p className="explore-eyebrow mb-3">Your selection</p>
      <h3 className="text-xl font-semibold tracking-tight break-words">
        {title}
      </h3>
      <div className="my-5 flex flex-wrap items-baseline gap-2">
        <span className="text-3xl font-semibold tracking-tight tabular-nums break-all">
          {price}
        </span>
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </div>
      <div className="space-y-3 border-t border-border pt-4 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
    </section>
  );
}
