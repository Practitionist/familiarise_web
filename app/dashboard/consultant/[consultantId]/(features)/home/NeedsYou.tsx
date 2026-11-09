import Link from "next/link";

import { Section } from "@/components/dashboard/Section";
import { Button } from "@/components/ui/button";

import type { HomeNeedsItem } from "./home-model";

/** What is waiting on the expert, most urgent first: one line and one button each. */
export function NeedsYou({ items }: Readonly<{ items: HomeNeedsItem[] }>) {
  return (
    <Section title="Needs you">
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          You&apos;re all caught up.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card shadow-elevation-1">
          {items.map((item) => (
            <li
              key={item.key}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
            >
              <p className="min-w-0 flex-1 text-sm">
                <span className="font-medium text-foreground">{item.text}</span>
                {item.detail && (
                  <span className="text-muted-foreground">
                    {" "}
                    · {item.detail}
                  </span>
                )}
              </p>
              <Button asChild size="sm" variant="outline">
                <Link
                  href={item.href}
                  aria-label={`${item.ctaLabel}: ${item.text}`}
                >
                  {item.ctaLabel}
                </Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
