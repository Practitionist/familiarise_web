import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { cn } from "@/utils/tailwind";

export function LandingContainer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-7xl px-6 sm:px-8 lg:px-12",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SectionIntro({
  eyebrow,
  title,
  description,
  id,
}: {
  eyebrow: string;
  title: ReactNode;
  description?: string;
  id?: string;
}) {
  return (
    <div className="max-w-2xl">
      <p className="mb-4 text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
        {eyebrow}
      </p>
      <h2
        id={id}
        className="text-3xl font-semibold leading-[1.15] tracking-[-0.045em] text-zinc-950 sm:text-4xl lg:text-[44px]"
      >
        {title}
      </h2>
      {description && (
        <p className="mt-5 max-w-xl text-base leading-relaxed text-zinc-600 sm:text-lg">
          {description}
        </p>
      )}
    </div>
  );
}

export function LandingTextLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex min-h-11 items-center gap-2 rounded-md text-sm font-medium text-zinc-900 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-current",
        className,
      )}
    >
      {children}
      <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
    </Link>
  );
}
