"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  articleToMarkdown,
  type SupportArticle,
} from "../_data/support-content";

/** Per-article actions: "Copy for LLM" copies the article as markdown. */
export function ArticleActions({ article }: { article: SupportArticle }) {
  const [copied, setCopied] = useState(false);
  // Repeated copies replace the pending reset instead of racing it, and the
  // timer never outlives the component.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

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
    <Button variant="outline" size="sm" onClick={copy}>
      {copied ? (
        <Check className="mr-2 h-4 w-4" aria-hidden />
      ) : (
        <Copy className="mr-2 h-4 w-4" aria-hidden />
      )}
      {copied ? "Copied" : "Copy for LLM"}
    </Button>
  );
}
