"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Check,
  ChevronsUpDown,
  Copy,
  LogOut,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/utils/tailwind";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PinnedCta } from "@/lib/dashboard/nav/types";

/** An entry in the account chip menu (Settings, Help & support, …). */
export interface ChipAction {
  label: string;
  href?: string;
  onClick?: () => void;
  icon?: LucideIcon;
}

/** The account chip answers "who am I" only — context lives in the switcher. */
export interface DashboardAccount {
  name: string | null;
  image: string | null;
  /** Humanized ("Owner", "Expert"), never a raw enum. */
  roleLabel: string;
  actions?: ChipAction[];
}

function AccountAvatar({ account }: Readonly<{ account: DashboardAccount }>) {
  return (
    <Avatar className="h-7 w-7 flex-shrink-0">
      <AvatarImage src={account.image || ""} alt="" />
      <AvatarFallback className="bg-zinc-700 text-xs font-semibold text-white">
        {(account.name ?? "U").charAt(0).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

function AccountText({ account }: Readonly<{ account: DashboardAccount }>) {
  return (
    <div className="min-w-0 flex-1">
      <p className="truncate text-xs font-medium leading-tight text-zinc-900 dark:text-zinc-100">
        {account.name}
      </p>
      <p className="mt-0.5 truncate text-[10px] leading-tight text-zinc-500 dark:text-zinc-400">
        {account.roleLabel}
      </p>
    </div>
  );
}

/** Sidebar footer chip: a menu of account actions ending in Sign out. */
export function AccountChip({
  account,
  onSignOut,
  collapsed,
}: Readonly<{
  account: DashboardAccount;
  onSignOut: () => void;
  collapsed: boolean;
}>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-left transition-colors hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800",
            collapsed &&
              "justify-center border-transparent bg-transparent px-0",
          )}
        >
          <AccountAvatar account={account} />
          {!collapsed && (
            <>
              <AccountText account={account} />
              <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-60">
        {(account.actions ?? []).map((action) => {
          const Icon = action.icon;
          const body = (
            <>
              {Icon && <Icon className="h-4 w-4 text-zinc-500" />}
              {action.label}
            </>
          );
          return action.href ? (
            <DropdownMenuItem
              key={action.label}
              asChild
              className="cursor-pointer gap-2"
            >
              <Link
                href={action.href}
                className="flex w-full items-center gap-2"
              >
                {body}
              </Link>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              key={action.label}
              onClick={action.onClick}
              className="cursor-pointer gap-2"
            >
              {body}
            </DropdownMenuItem>
          );
        })}
        {(account.actions ?? []).length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={onSignOut} className="cursor-pointer gap-2">
          <LogOut className="h-4 w-4 text-zinc-500" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Mobile Menu sheet: the same account block, expanded (no nested menu). */
export function AccountRow({
  account,
  onSignOut,
  onNavigate,
}: Readonly<{
  account: DashboardAccount;
  onSignOut: () => void;
  onNavigate?: () => void;
}>) {
  const rowClass =
    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100";
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <AccountAvatar account={account} />
        <AccountText account={account} />
      </div>
      {(account.actions ?? []).map((action) => {
        const Icon = action.icon;
        const body = (
          <>
            {Icon && <Icon className="h-5 w-5" />}
            {action.label}
          </>
        );
        return action.href ? (
          <Link
            key={action.label}
            href={action.href}
            onClick={onNavigate}
            className={rowClass}
          >
            {body}
          </Link>
        ) : (
          <button
            key={action.label}
            type="button"
            onClick={() => {
              onNavigate?.();
              action.onClick?.();
            }}
            className={rowClass}
          >
            {body}
          </button>
        );
      })}
      <button type="button" onClick={onSignOut} className={rowClass}>
        <LogOut className="h-5 w-5" />
        Sign out
      </button>
    </div>
  );
}

/**
 * Per-persona pinned CTA ("View public page" / "Find experts"), with an
 * optional copy-link affordance for sharing the expert's page (#1527 §7.2).
 */
export function PinnedCtaButton({
  cta,
  collapsed = false,
  onNavigate,
}: Readonly<{ cta: PinnedCta; collapsed?: boolean; onNavigate?: () => void }>) {
  const [copied, setCopied] = useState(false);
  const Icon = cta.icon;
  const linkClass = cn(
    "flex min-w-0 flex-1 items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800",
    collapsed && "justify-center border-transparent px-0",
  );
  const body = (
    <>
      <Icon className="h-4 w-4 shrink-0" />
      {collapsed ? (
        <span className="sr-only">{cta.label}</span>
      ) : (
        <span className="truncate">{cta.label}</span>
      )}
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
    <div className="flex items-center gap-1">
      {cta.external ? (
        <a
          href={cta.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onNavigate}
          className={linkClass}
        >
          {body}
        </a>
      ) : (
        <Link href={cta.href} onClick={onNavigate} className={linkClass}>
          {body}
        </Link>
      )}
      {cta.copyText && !collapsed && (
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? "Link copied" : "Copy link"}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-800 dark:hover:bg-zinc-800"
        >
          {copied ? (
            <Check className="h-4 w-4" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </button>
      )}
    </div>
  );
}
