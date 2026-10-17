"use client";

import type { MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { canGoBackInApp } from "@/lib/navigation/in-app-history";
import { cn } from "@/utils/tailwind";

export interface BackNavigationButtonProps {
  readonly fallbackHref: string;
  readonly label: string;
  readonly className?: string;
}

export function BackNavigationButton({
  fallbackHref,
  label,
  className,
}: Readonly<BackNavigationButtonProps>) {
  const router = useRouter();

  const handleBack = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    ) {
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    // document.referrer alone is unreliable (empty on direct entry, never
    // updated by client-side navigations), so consult the in-app trail too.
    if (canGoBackInApp()) {
      event.preventDefault();
      router.back();
    }
  };

  return (
    <Link
      href={fallbackHref}
      onClick={handleBack}
      className={cn(
        "inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors",
        className,
      )}
    >
      <ArrowLeft className="h-4 w-4 shrink-0" />
      <span>{label}</span>
    </Link>
  );
}
