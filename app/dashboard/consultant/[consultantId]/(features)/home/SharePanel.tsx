"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

import { Section } from "@/components/dashboard/Section";
import { Button } from "@/components/ui/button";

/** Your own signed link: sales that start from it pay the lower personal-link fee. */
export function SharePanel({
  shareUrl,
}: Readonly<{ shareUrl: string | null }>) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!shareUrl) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Section title="Share your page" variant="card">
      <div className="flex items-center gap-2">
        <p
          className="min-w-0 flex-1 truncate rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground"
          title={shareUrl}
        >
          {shareUrl.replace(/^https?:\/\//, "")}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void copy()}
          className="shrink-0 gap-1.5"
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Sales that start from this link pay the lower personal-link fee.
      </p>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? "Link copied" : ""}
      </span>
    </Section>
  );
}
