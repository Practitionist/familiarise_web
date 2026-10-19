"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, ThumbsDown, ThumbsUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth-client";
import {
  articleToMarkdown,
  type SupportArticle,
} from "../_data/support-content";

type Vote = "yes" | "no";

/**
 * Per-article actions: "Copy for LLM" (markdown to clipboard, mirroring the
 * reference UI) plus a was-this-helpful vote.
 *
 * The vote is SIGNED IN and really recorded: it is written to
 * `SupportArticleFeedback` through POST /api/support/articles/{slug}/feedback,
 * one row per reader per article, so the support team can see which articles
 * are failing. Before that it was a control that looked like it recorded
 * something and did not — a broken promise to the reader.
 *
 * A "No" still offers the contact path: the vote tells us WHICH article
 * failed, the ticket tells us what the reader was actually trying to do.
 */
export function ArticleActions({ article }: { article: SupportArticle }) {
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState<Vote | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [isVoting, setIsVoting] = useState(false);
  const [rejectedAsSignedOut, setRejectedAsSignedOut] = useState(false);
  // Repeated copies replace the pending reset instead of racing it, and the
  // timer never outlives the component.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pathname = usePathname();
  const { data: session, isPending: sessionPending } = useSession();
  const signedIn = Boolean(session?.user?.id);
  // A signed-out reader is told up front; a session that has not resolved yet
  // is not treated as signed out, so the buttons do not flash away.
  const requiresSignIn = rejectedAsSignedOut || (!sessionPending && !signedIn);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const contactHref = `/contactus?category=${encodeURIComponent(article.contactCategory)}`;
  // The reader comes back to the article they were on, not the front door.
  const signInHref = pathname
    ? `/auth/signin?callbackUrl=${encodeURIComponent(pathname)}`
    : "/auth/signin";

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

  async function submitVote(next: Vote) {
    if (isVoting) return;
    setIsVoting(true);
    setVoteError(null);
    try {
      const response = await fetch(
        `/api/support/articles/${encodeURIComponent(article.slug)}/feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ helpful: next === "yes" }),
        },
      );
      if (response.status === 401) {
        // The session ended between render and click: the vote was NOT
        // recorded, so say so rather than showing a thank-you that lies.
        setRejectedAsSignedOut(true);
        return;
      }
      if (!response.ok) {
        setVoteError("We could not save that — please try again.");
        return;
      }
      setVote(next);
    } catch {
      setVoteError("We could not save that — please try again.");
    } finally {
      setIsVoting(false);
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
        {requiresSignIn ? (
          <p className="mt-2 text-sm text-muted-foreground">
            <Link href={signInHref} className="underline underline-offset-2">
              Sign in
            </Link>{" "}
            to tell us if this article helped. One vote per person, per article
            — and it is how we find the articles that need fixing.
          </p>
        ) : (
          <>
            <div className="mt-2 flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => submitVote("yes")}
                aria-pressed={vote === "yes"}
                aria-label="Yes, this article was helpful"
                disabled={isVoting}
              >
                <ThumbsUp className="mr-1.5 h-4 w-4" aria-hidden />
                Yes
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => submitVote("no")}
                aria-pressed={vote === "no"}
                aria-label="No, this article was not helpful"
                disabled={isVoting}
              >
                <ThumbsDown className="mr-1.5 h-4 w-4" aria-hidden />
                No
              </Button>
            </div>
            {vote === "yes" && (
              <p className="mt-2 text-sm text-muted-foreground">
                Thanks for the feedback.
              </p>
            )}
            {vote === "no" && (
              <p className="mt-2 text-sm text-muted-foreground">
                Sorry it missed.{" "}
                <Link
                  href={contactHref}
                  className="underline underline-offset-2"
                >
                  Contact support
                </Link>{" "}
                with what you were trying to do and we will help.
              </p>
            )}
            {voteError && (
              <p className="mt-2 text-sm text-destructive">{voteError}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
