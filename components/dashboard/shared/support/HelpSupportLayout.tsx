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
    <div className="grid min-w-0 gap-6 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-8">
      <nav aria-label="Help and support pages" className="space-y-5">
        <div>
          <p className="mb-2 px-2 text-xs font-medium text-muted-foreground">
            {organization ? "Organization help & support" : "Help & support"}
          </p>
          <ul className="flex flex-wrap gap-1 lg:flex-col">
            {items.map(({ label, href, icon: Icon }) => (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={pathname === href ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-muted/50",
                    pathname === href
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground",
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
          <div className="space-y-2 border-t border-border px-2 pt-4 text-sm">
            <p className="text-xs font-medium text-muted-foreground">
              Your personal workspace
            </p>
            <Link
              className="block underline underline-offset-4"
              href={goHref("auto", "support/reports")}
            >
              Personal reports & appeals
            </Link>
            <Link
              className="block underline underline-offset-4"
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
