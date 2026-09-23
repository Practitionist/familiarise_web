"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, ThumbsDown, ThumbsUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  articleToMarkdown,
  type SupportArticle,
} from "../_data/support-content";

/**
 * Per-article actions: "Copy for LLM" (markdown to clipboard, mirroring the
 * reference UI) plus a lightweight was-this-helpful vote that escalates to
 * Contact us on a "No".
 */
export function ArticleActions({ article }: { article: SupportArticle }) {
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState<"yes" | "no" | null>(null);
  // Repeated copies replace the pending reset instead of racing it, and the
  // timer never outlives the component.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const contactHref = `/contactus?category=${encodeURIComponent(article.contactCategory)}`;

  async function copy() {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    try {
      await navigator.clipboard.writeText(articleToMarkdown(article));
      setCopied(true);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? (
            <Check className="mr-2 h-4 w-4" aria-hidden />
          ) : (
            <Copy className="mr-2 h-4 w-4" aria-hidden />
          )}
          {copied ? "Copied" : "Copy for LLM"}
        </Button>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <p className="text-sm font-medium">Was this article helpful?</p>
        {vote === null ? (
          <div className="mt-2 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setVote("yes")}
              aria-label="Yes, helpful"
            >
              <ThumbsUp className="mr-1.5 h-4 w-4" aria-hidden />
              Yes
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setVote("no")}
              aria-label="No, not helpful"
            >
              <ThumbsDown className="mr-1.5 h-4 w-4" aria-hidden />
              No
            </Button>
          </div>
        ) : vote === "yes" ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Thanks for the feedback.
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            Sorry it missed.{" "}
            <Link href={contactHref} className="underline underline-offset-2">
              Contact support
            </Link>{" "}
            with what you were trying to do and we will help.
          </p>
        )}
      </div>
    </div>
  );
}
