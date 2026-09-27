"use client";

/**
 * "Find" quick-jump (#1527): a box under the switcher (an icon on the
 * collapsed rail, a row in the mobile Menu sheet) and Ctrl/⌘ K open a
 * dialog listing every page and settings section this viewer can open,
 * grouped as in the sidebar. Arrows move, Enter opens, Esc closes.
 */

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { filterFind, type FindEntry } from "@/lib/dashboard/nav/find-index";
import { cn } from "@/utils/tailwind";

/** Ctrl/⌘ K opens Find; Ctrl/⌘ \ stays the rail toggle. */
export function useFindShortcut(open: () => void) {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k") return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return;
      }
      event.preventDefault();
      open();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);
}

/** The sidebar / sheet entry point; icon-only on the collapsed rail. */
export function FindButton({
  onOpen,
  collapsed = false,
}: Readonly<{ onOpen: () => void; collapsed?: boolean }>) {
  const button = (
    <button
      type="button"
      onClick={onOpen}
      aria-label={collapsed ? "Find a page" : undefined}
      aria-haspopup="dialog"
      aria-keyshortcuts="Control+K Meta+K"
      className={cn(
        "flex items-center gap-2 rounded-lg border border-border bg-background text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        collapsed ? "h-9 w-9 justify-center" : "h-9 w-full px-3",
      )}
    >
      <Search className="h-4 w-4 shrink-0" aria-hidden />
      {!collapsed && (
        <>
          <span className="flex-1 text-left">Find</span>
          <kbd
            aria-hidden
            className="rounded border border-border px-1.5 font-mono text-[10px] text-muted-foreground"
          >
            Ctrl/⌘ K
          </kbd>
        </>
      )}
    </button>
  );
  if (!collapsed) return button;
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right">Find (Ctrl/⌘ K)</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function FindList({
  entries,
  onClose,
}: Readonly<{ entries: FindEntry[]; onClose: () => void }>) {
  const router = useRouter();
  const baseId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => filterFind(entries, query), [entries, query]);
  const current = Math.min(active, Math.max(0, results.length - 1));
  const optionId = (i: number) => `${baseId}-option-${i}`;

  const go = (entry: FindEntry | undefined) => {
    if (!entry) return;
    onClose();
    router.push(entry.href);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const last = results.length - 1;
    const moves: Record<string, number> = {
      ArrowDown: current >= last ? 0 : current + 1,
      ArrowUp: current <= 0 ? last : current - 1,
      Home: 0,
      End: last,
    };
    if (event.key in moves && results.length > 0) {
      event.preventDefault();
      setActive(moves[event.key]);
      document
        .getElementById(optionId(moves[event.key]))
        ?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(results[current]);
    }
  };

  // Consecutive entries share a group: render a caption where it changes.
  // A title can recur (two unlabelled nav groups, or ranking splitting one),
  // so groups key by their first href: keyed by title, React reused a stale
  // group and two options stayed aria-selected (#1527 QA G10).
  const groups: {
    title: string;
    items: { entry: FindEntry; index: number }[];
  }[] = [];
  results.forEach((entry, index) => {
    const last = groups.at(-1);
    if (last?.title === entry.group) last.items.push({ entry, index });
    else groups.push({ title: entry.group, items: [{ entry, index }] });
  });

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          role="combobox"
          aria-expanded
          aria-controls={`${baseId}-list`}
          aria-activedescendant={
            results.length > 0 ? optionId(current) : undefined
          }
          aria-autocomplete="list"
          aria-label="Find a page"
          placeholder="Type a page name, e.g. invoices"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-10 pl-8"
        />
      </div>
      <p
        role="status"
        aria-live="polite"
        className={
          results.length === 0
            ? "px-2 py-6 text-center text-sm text-muted-foreground"
            : "sr-only"
        }
      >
        {results.length === 0 && <>No pages match &ldquo;{query}&rdquo;</>}
      </p>
      <div
        id={`${baseId}-list`}
        role="listbox"
        aria-label="Pages"
        className="max-h-[60vh] overflow-y-auto"
      >
        {groups.map((group, gi) => (
          <div
            key={group.items[0].entry.href}
            role="group"
            aria-labelledby={`${baseId}-group-${gi}`}
            className="pb-2"
          >
            <p
              id={`${baseId}-group-${gi}`}
              className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {group.title}
            </p>
            {group.items.map(({ entry, index }) => (
              <div
                key={entry.href}
                id={optionId(index)}
                role="option"
                aria-selected={index === current}
                tabIndex={-1}
                onMouseEnter={() => setActive(index)}
                onClick={() => go(entry)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") go(entry);
                }}
                className={cn(
                  "cursor-pointer rounded-md px-2 py-2 text-sm",
                  index === current
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {entry.label}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function FindDialog({
  open,
  onOpenChange,
  entries,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: FindEntry[];
}>) {
  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="sm:max-w-lg">
        <ResponsiveModalTitle>Find a page</ResponsiveModalTitle>
        <ResponsiveModalDescription className="sr-only">
          Jump to any page or settings section you can open here.
        </ResponsiveModalDescription>
        {/* Mounted per open, so each opening starts from an empty search. */}
        {open && (
          <FindList entries={entries} onClose={() => onOpenChange(false)} />
        )}
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
