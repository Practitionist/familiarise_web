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
import { PageHeader } from "@/components/dashboard/PageScaffold";

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
    { label: "Support cases", href: root, icon: MessagesSquare },
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
      <PageHeader
        title="Help & support"
        description={
          organization
            ? "Get help and follow support activity for this organization."
            : "Get help, follow support cases, and share product feedback."
        }
        className="mb-0"
      />
      <nav aria-label="Help and support pages" className="min-w-0 space-y-3">
        <div className="-mx-1 overflow-x-auto px-1 py-1">
          <ul className="flex min-w-max items-center gap-6 border-b border-border">
            {items.map(({ label, href, icon: Icon }) => (
              <li key={href} className="shrink-0">
                <Link
                  href={href}
                  aria-current={pathname === href ? "page" : undefined}
                  className={cn(
                    "-mb-px inline-flex items-center justify-center gap-2 whitespace-nowrap border-b-2 px-0.5 py-3 text-sm font-medium transition-colors focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    pathname === href
                      ? "border-foreground text-foreground"
                      : "border-transparent text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
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
