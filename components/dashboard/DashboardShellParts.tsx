"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  Inbox,
  LifeBuoy,
  LogOut,
  MessageSquareText,
  Settings,
} from "lucide-react";

import { cn } from "@/utils/tailwind";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSession } from "@/lib/auth-client";
import type { PinnedCta, SupportLinks } from "@/lib/dashboard/nav/types";

/**
 * The person behind the header avatar menu. Context (which dashboard) lives in
 * the switcher; this answers "who am I" once, in the header (#1527).
 */
export interface DashboardAccount {
  name: string | null;
  image: string | null;
  /** Humanized ("Owner", "Expert"), never a raw enum. */
  roleLabel: string;
  /** The one "Settings" entry (#1527); null hides it (mid-onboarding). */
  settingsHref: string | null;
}

/** Header avatar menu: identity, Settings, Sign out (#1527). */
export function AccountMenu({
  account,
  onSignOut,
}: Readonly<{ account: DashboardAccount; onSignOut: () => void }>) {
  // The email only renders inside the open menu, so reading it from the
  // client session cannot cause a hydration mismatch.
  const { data: session } = useSession();
  const email = session?.user?.email ?? null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300"
        >
          <Avatar className="h-8 w-8">
            <AvatarImage src={account.image || ""} alt="" />
            <AvatarFallback className="bg-zinc-700 text-xs font-semibold text-white">
              {(account.name ?? "U").charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {account.name}
          </p>
          {email && (
            <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
              {email}
            </p>
          )}
          <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
            {account.roleLabel}
          </p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {account.settingsHref && (
          <DropdownMenuItem asChild className="cursor-pointer gap-2">
            <Link
              href={account.settingsHref}
              className="flex w-full items-center gap-2"
            >
              <Settings className="h-4 w-4 text-zinc-500" />
              Settings
            </Link>
          </DropdownMenuItem>
        )}
        {account.settingsHref && <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={onSignOut} className="cursor-pointer gap-2">
          <LogOut className="h-4 w-4 text-zinc-500" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The public Help Center — the one home for articles (#1527). */
export const HELP_CENTER_HREF = "/support";

/**
 * Header "Help" menu (#1527): the public Help Center in a new tab, then the
 * viewer's own Support requests and Send feedback when they have them. Icon +
 * label at md+, icon-only below.
 */
export function HelpMenu({
  support,
}: Readonly<{ support: SupportLinks | null }>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Help"
          className="shrink-0 gap-1 px-2 text-zinc-600 dark:text-zinc-300"
        >
          <LifeBuoy className="h-4 w-4" />
          <span className="hidden md:inline">Help</span>
          <ChevronDown className="hidden h-3.5 w-3.5 md:inline" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem asChild className="cursor-pointer gap-2">
          <a
            href={HELP_CENTER_HREF}
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-full items-center gap-2"
          >
            <LifeBuoy className="h-4 w-4 text-zinc-500" />
            Help Center
            <ArrowUpRight
              className="ml-auto h-3.5 w-3.5 text-zinc-400"
              aria-hidden
            />
          </a>
        </DropdownMenuItem>
        {support && (
          <DropdownMenuItem asChild className="cursor-pointer gap-2">
            <Link
              href={support.requestsHref}
              className="flex w-full items-center gap-2"
            >
              <Inbox className="h-4 w-4 text-zinc-500" />
              Support requests
            </Link>
          </DropdownMenuItem>
        )}
        {support?.feedbackHref && (
          <DropdownMenuItem asChild className="cursor-pointer gap-2">
            <Link
              href={support.feedbackHref}
              className="flex w-full items-center gap-2"
            >
              <MessageSquareText className="h-4 w-4 text-zinc-500" />
              Send feedback
            </Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Per-persona header CTA ("Find experts" / "View public page") with an
 * optional copy-link button for sharing the expert's page (#1527 §7.2).
 * `fullWidth` is the mobile Menu sheet's variant.
 */
export function HeaderCta({
  cta,
  fullWidth = false,
  onNavigate,
}: Readonly<{ cta: PinnedCta; fullWidth?: boolean; onNavigate?: () => void }>) {
  const [copied, setCopied] = useState(false);
  const Icon = cta.icon;
  const body = (
    <>
      <Icon className="h-4 w-4" />
      <span className="truncate">{cta.label}</span>
    </>
  );

  const copy = async () => {
    if (!cta.copyText) return;
    const text = cta.copyText.startsWith("/")
      ? `${window.location.origin}${cta.copyText}`
      : cta.copyText;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied: the link itself still works.
    }
  };

  return (
    <div
      className={cn("flex shrink-0 items-center gap-1", fullWidth && "w-full")}
    >
      <Button
        variant="outline"
        size="sm"
        asChild
        className={cn(fullWidth && "flex-1 justify-start")}
      >
        {cta.external ? (
          <a
            href={cta.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onNavigate}
          >
            {body}
          </a>
        ) : (
          <Link href={cta.href} onClick={onNavigate}>
            {body}
          </Link>
        )}
      </Button>
      {cta.copyText && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => void copy()}
          aria-label={copied ? "Link copied" : "Copy link"}
          className="h-8 w-8 shrink-0"
        >
          {copied ? (
            <Check className="h-4 w-4" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      )}
    </div>
  );
}
