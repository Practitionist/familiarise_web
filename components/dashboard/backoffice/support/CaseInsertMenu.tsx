"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { insertMenuArticles } from "@/lib/support/insert-articles";
import type { SavedReply } from "@/lib/support/saved-replies";
import type { ArticleLink } from "@/types/support-case";

/** The text an article inserts: its title and an absolute link. */
export const articleInsertText = (a: ArticleLink) =>
  `${a.title}: ${window.location.origin}${a.href}`;

const heading =
  "px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground";
const item =
  "block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none";

/**
 * #1527 — the composer's "Insert" menu: the topic's saved replies, then Help
 * Center articles (the topic's suggestions, or a title search over all).
 */
export function CaseInsertMenu({
  replies,
  suggested,
  all,
  onInsert,
}: Readonly<{
  replies: SavedReply[];
  suggested: ArticleLink[];
  all: ArticleLink[];
  onInsert: (text: string) => void;
}>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const articles = insertMenuArticles(suggested, all, query);
  const pick = (text: string) => {
    onInsert(text);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">
          Insert
          <ChevronDown className="ml-1 h-3 w-3" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-1">
        <div className="max-h-80 overflow-y-auto">
          <p className={heading}>Saved replies</p>
          <ul>
            {replies.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={item}
                  onClick={() => pick(r.body)}
                >
                  <span className="block font-medium text-foreground">
                    {r.title}
                  </span>
                  <span className="line-clamp-1 text-xs text-muted-foreground">
                    {r.body}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className={heading}>Help Center articles</p>
          <div className="px-1 pb-1">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search articles"
              aria-label="Search Help Center articles"
              className="h-8 text-sm"
            />
          </div>
          {articles.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              No matching articles.
            </p>
          ) : (
            <ul>
              {articles.map((a) => (
                <li key={a.href}>
                  <button
                    type="button"
                    className={item}
                    onClick={() => pick(articleInsertText(a))}
                  >
                    {a.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
