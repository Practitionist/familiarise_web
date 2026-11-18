"use client";

/**
 * Finds a verified expert to invite. A labelled combobox: type to search, the
 * arrow keys move through the matches, Enter picks one and Escape closes the
 * list. What the search found is announced, including when it found nobody.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { z } from "zod";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/utils/tailwind";

const expertSchema = z.object({
  id: z.string(),
  user: z.object({
    name: z.string().nullable(),
    image: z.string().nullable(),
    email: z.string().optional(),
  }),
});
const resultsSchema = z.object({ data: z.array(expertSchema) });

export type ExpertResult = z.infer<typeof expertSchema>;

/** The last search that came back: its query and what it found, or null when it failed. */
type Settled = { query: string; results: ExpertResult[] | null };

const nameOf = (expert: ExpertResult) => expert.user.name ?? "Unnamed expert";

function ExpertLine({ expert }: Readonly<{ expert: ExpertResult }>) {
  return (
    <>
      <Avatar className="h-8 w-8 shrink-0">
        <AvatarImage src={expert.user.image ?? undefined} alt="" />
        <AvatarFallback className="text-xs">
          {nameOf(expert).charAt(0)}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {nameOf(expert)}
        </span>
        {expert.user.email && (
          <span className="block truncate text-xs text-muted-foreground">
            {expert.user.email}
          </span>
        )}
      </span>
    </>
  );
}

function announcement(query: string, settled: Settled | null): string {
  if (query.length === 0) {
    return "Type a name. Only verified experts can be invited.";
  }
  if (settled?.query !== query) return "Searching…";
  if (settled.results === null) {
    return "The search is not available right now. Try again in a moment.";
  }
  const count = settled.results.length;
  if (count === 0) return `No verified expert matches “${query}”.`;
  return `${count} ${count === 1 ? "expert" : "experts"} found.`;
}

export function ConsultantSearchInput({
  label,
  selected,
  onSelect,
  unavailable,
  onListOpenChange,
}: Readonly<{
  label: string;
  selected: ExpertResult | null;
  onSelect: (expert: ExpertResult | null) => void;
  /** Profiles that cannot be picked, with the reason shown beside each. */
  unavailable?: ReadonlyMap<string, string>;
  /** Lets a surrounding dialog leave Escape to the open list. */
  onListOpenChange?: (open: boolean) => void;
}>) {
  const [text, setText] = useState("");
  const [settled, setSettled] = useState<Settled | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<"input" | "change" | null>(null);
  const inputId = useId();
  const listId = useId();
  const statusId = useId();

  const query = text.trim();
  const current = settled?.query === query ? settled : null;
  const searching = query.length > 0 && current === null;
  const results = current?.results ?? [];
  const listOpen = open && results.length > 0;

  useEffect(() => {
    onListOpenChange?.(listOpen);
  }, [listOpen, onListOpenChange]);

  // One request per pause in typing; a newer query cancels the one before it.
  useEffect(() => {
    if (query.length === 0) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      let found: ExpertResult[] | null = null;
      try {
        const res = await fetch(
          `/api/consultants/search?${new URLSearchParams({ q: query })}`,
          { signal: controller.signal },
        );
        const parsed = res.ok
          ? resultsSchema.safeParse(await res.json().catch(() => null))
          : null;
        found = parsed?.success ? parsed.data.data : null;
      } catch {
        found = null;
      }
      if (controller.signal.aborted) return;
      // Results never open the list themselves: focus, typing and the arrow keys do.
      setSettled({ query, results: found });
      setActiveIndex(0);
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  // Picking and changing swap the control under the caret; focus follows it.
  useEffect(() => {
    if (focusNext.current === "change") changeRef.current?.focus();
    if (focusNext.current === "input") inputRef.current?.focus();
    focusNext.current = null;
  }, [selected]);

  const pick = (expert: ExpertResult) => {
    if (unavailable?.has(expert.id)) return;
    focusNext.current = "change";
    setOpen(false);
    setText("");
    onSelect(expert);
  };

  if (selected) {
    return (
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <div className="mt-1.5 flex items-center gap-3 rounded-lg border border-border bg-muted/40 p-2">
          <ExpertLine expert={selected} />
          <Button
            ref={changeRef}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              focusNext.current = "input";
              onSelect(null);
            }}
          >
            Change <span className="sr-only">expert</span>
          </Button>
        </div>
      </div>
    );
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (results.length === 0) return;
      e.preventDefault();
      setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActiveIndex(
        (i) => (i + step + results.length) % Math.max(1, results.length),
      );
    } else if (e.key === "Enter" && listOpen) {
      e.preventDefault();
      const expert = results[activeIndex];
      if (expert) pick(expert);
    } else if (e.key === "Escape" && listOpen) {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div>
      <Label htmlFor={inputId}>{label}</Label>
      <div className="relative mt-1.5">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          id={inputId}
          role="combobox"
          aria-expanded={listOpen}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            listOpen ? `${listId}-${activeIndex}` : undefined
          }
          aria-describedby={statusId}
          autoComplete="off"
          placeholder="Search by name"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          className="pl-8 pr-8"
        />
        {searching && (
          <Loader2
            aria-hidden
            className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
          />
        )}
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching experts"
          hidden={!listOpen}
          className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-border bg-background shadow-lg"
        >
          {results.map((expert, index) => {
            const reason = unavailable?.get(expert.id);
            return (
              <li
                key={expert.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                aria-disabled={reason ? true : undefined}
                // Keeps the caret in the field, so a tap picks without closing the list first.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(expert)}
                // A screen reader's own cursor can rest on an option; Enter or Space picks it there.
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  pick(expert);
                }}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2",
                  index === activeIndex && "bg-muted",
                  reason && "cursor-not-allowed opacity-70",
                )}
              >
                <ExpertLine expert={expert} />
                {reason && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {reason}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className="mt-1.5 text-xs text-muted-foreground"
      >
        {announcement(query, settled)}
      </p>
    </div>
  );
}
