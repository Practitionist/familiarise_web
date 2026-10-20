"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FileCheck,
  Lightbulb,
  MessagesSquare,
  ShieldCheck,
  Users,
} from "lucide-react";
import { cn } from "@/utils/tailwind";
import { goHref } from "@/lib/dashboard/go";

/** Secondary page navigation stays out of request details so forms retain their full width. */
export function HelpSupportLayout({
  basePath,
  organization = false,
  canTriage = false,
  children,
}: Readonly<{
  basePath: string;
  organization?: boolean;
  canTriage?: boolean;
  children: ReactNode;
}>) {
  const pathname = usePathname();
  const root = `${basePath}/support`;
  if (
    pathname.startsWith(`${root}/requests/`) ||
    pathname.startsWith(`${root}/evidence/`)
  )
    return children;
  const items = [
    { label: "Support requests", href: root, icon: MessagesSquare },
    { label: "Evidence requests", href: `${root}/evidence`, icon: FileCheck },
    ...(!organization
      ? [
          {
            label: "Reports & appeals",
            href: `${root}/reports`,
            icon: ShieldCheck,
          },
          {
            label: "Product feedback",
            href: `${root}/feedback`,
            icon: Lightbulb,
          },
        ]
      : []),
    ...(organization && canTriage
      ? [
          {
            label: "Member support activity",
            href: `${root}/activity`,
            icon: Users,
          },
        ]
      : []),
  ];
  return (
    <div className="min-w-0 space-y-6">
      <nav aria-label="Help and support pages" className="min-w-0 space-y-3">
        <div className="overflow-x-auto pb-1">
          <ul className="inline-flex w-max items-center gap-1 rounded-lg bg-muted p-1">
            {items.map(({ label, href, icon: Icon }) => (
              <li key={href} className="shrink-0">
                <Link
                  href={href}
                  aria-current={pathname === href ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    pathname === href
                      ? "bg-background text-foreground shadow"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        {organization && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <p className="text-xs font-medium text-muted-foreground">
              Your personal workspace
            </p>
            <Link
              className="underline underline-offset-4"
              href={goHref("auto", "support/reports")}
            >
              Personal reports & appeals
            </Link>
            <Link
              className="underline underline-offset-4"
              href={goHref("auto", "support/feedback")}
            >
              Your product feedback
            </Link>
          </div>
        )}
      </nav>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
