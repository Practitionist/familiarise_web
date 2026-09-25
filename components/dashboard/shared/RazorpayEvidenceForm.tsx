"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { rupeesToPaise } from "@/lib/backoffice/rupees";

/** Razorpay's evidence lists, in its own field names (razorpay-disputes.ts). */
const CATEGORIES = [
  { key: "proof_of_service", label: "Proof of service" },
  { key: "customer_communication", label: "Customer communication" },
  {
    key: "refund_cancellation_policy",
    label: "Refund and cancellation policy",
  },
  { key: "term_and_conditions", label: "Terms and conditions" },
  { key: "explanation_letter", label: "Explanation letter" },
  { key: "others", label: "Other" },
] as const;
type CategoryKey = (typeof CATEGORIES)[number]["key"];
type Doc = { id: string; name: string };
type Docs = Record<CategoryKey, Doc[]>;

const EMPTY: Docs = {
  proof_of_service: [],
  customer_communication: [],
  refund_cancellation_policy: [],
  term_and_conditions: [],
  explanation_letter: [],
  others: [],
};
const SUMMARY_MAX = 1000;

const without = (list: Doc[], id: string) => list.filter((d) => d.id !== id);

function useCountdown(dueBy: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  if (!dueBy) return null;
  const ms = new Date(dueBy).getTime() - now;
  if (ms <= 0) return "The evidence deadline has passed.";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  return `${days} days and ${hours} hours left to respond.`;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

/**
 * #1771 K-7 — Razorpay dispute evidence: files upload one by one to
 * Razorpay's document store as they are picked, then the summary and the
 * document ids are saved as a draft or submitted. Submitting needs at least
 * one document and moves the dispute to under review.
 */
export function RazorpayEvidenceForm({
  disputeId,
  dueBy,
  queryKey,
}: Readonly<{
  disputeId: string;
  dueBy: string | null;
  queryKey: readonly unknown[];
}>) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const countdown = useCountdown(dueBy);
  const [docs, setDocs] = useState<Docs>(EMPTY);
  const [otherType, setOtherType] = useState("");
  const [summary, setSummary] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [uploading, setUploading] = useState<CategoryKey | null>(null);
  const docCount = Object.values(docs).reduce((n, d) => n + d.length, 0);

  const upload = async (key: CategoryKey, file: File) => {
    setUploading(key);
    try {
      const form = new FormData();
      form.append("disputeId", disputeId);
      form.append("file", file);
      const res = await fetch("/api/payments/disputes", {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error(await readError(res, "Upload failed"));
      const doc = (await res.json()) as { documentId: string; name: string };
      setDocs((d) => ({
        ...d,
        [key]: [...d[key], { id: doc.documentId, name: doc.name }],
      }));
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setUploading(null);
    }
  };

  const contest = useMutation({
    mutationFn: async (action: "draft" | "submit") => {
      const ids = (key: CategoryKey) => docs[key].map((d) => d.id);
      const evidence = {
        proof_of_service: ids("proof_of_service"),
        customer_communication: ids("customer_communication"),
        refund_cancellation_policy: ids("refund_cancellation_policy"),
        term_and_conditions: ids("term_and_conditions"),
        explanation_letter: ids("explanation_letter"),
        others:
          docs.others.length > 0
            ? [
                {
                  type: otherType.trim() || "other",
                  document_ids: ids("others"),
                },
              ]
            : [],
      };
      const res = await fetch("/api/payments/disputes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          disputeId,
          action,
          summary: summary.trim(),
          ...(amountPaise ? { amountPaise } : {}),
          evidence,
          reason: reason.trim(),
        }),
      });
      if (!res.ok) throw new Error(await readError(res, "Razorpay refused it"));
      const json = (await res.json()) as { localStampFailed?: boolean };
      return { action, localStampFailed: json.localStampFailed === true };
    },
    onSuccess: ({ action, localStampFailed }) => {
      toast({
        title:
          action === "submit"
            ? "Evidence submitted"
            : "Draft saved on Razorpay",
        // Razorpay has it; only our copy lags. Retrying would be refused.
        description: localStampFailed
          ? "Razorpay accepted it, but this page could not record it yet — do not resubmit; engineering has been alerted."
          : undefined,
      });
      void queryClient.invalidateQueries({ queryKey: [...queryKey] });
    },
    onError: (err: Error) =>
      toast({
        title: "Not done",
        description: err.message,
        variant: "destructive",
      }),
  });

  const removeDoc = (key: CategoryKey, id: string) =>
    setDocs((all) => ({ ...all, [key]: without(all[key], id) }));
  // Empty = contest the whole amount; anything else must be whole paise.
  const amountPaise = amount.trim() === "" ? null : rupeesToPaise(amount);
  const amountOk = amount.trim() === "" || (amountPaise ?? 0) > 0;
  const ready =
    summary.trim().length > 0 && reason.trim().length >= 5 && amountOk;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Respond on Razorpay</CardTitle>
        {countdown && (
          <output className="block text-sm text-muted-foreground">
            {countdown}
          </output>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="rzp-summary">Summary for the bank</Label>
          <Textarea
            id="rzp-summary"
            value={summary}
            maxLength={SUMMARY_MAX}
            onChange={(e) => setSummary(e.target.value)}
            rows={4}
          />
          <p className="text-xs text-muted-foreground">
            {summary.length} of {SUMMARY_MAX} characters
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rzp-amount">
            Amount to contest in rupees (empty = all)
          </Label>
          <Input
            id="rzp-amount"
            inputMode="decimal"
            value={amount}
            aria-invalid={!amountOk}
            onChange={(e) => setAmount(e.target.value)}
          />
          {!amountOk && (
            <p className="text-xs text-destructive">
              Enter rupees with at most two decimals, like 1500 or 1500.50.
            </p>
          )}
        </div>
        {CATEGORIES.map((cat) => (
          <div key={cat.key} className="space-y-1.5">
            <Label htmlFor={`rzp-${cat.key}`}>{cat.label}</Label>
            {cat.key === "others" && (
              <Input
                aria-label="What the other documents are"
                placeholder="What these documents are"
                value={otherType}
                onChange={(e) => setOtherType(e.target.value)}
              />
            )}
            <Input
              id={`rzp-${cat.key}`}
              type="file"
              accept=".jpg,.jpeg,.png,.pdf"
              disabled={uploading !== null}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(cat.key, file);
                e.target.value = "";
              }}
            />
            {docs[cat.key].length > 0 && (
              <ul className="space-y-1 text-sm">
                {docs[cat.key].map((d) => (
                  <li
                    key={d.id}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="truncate">{d.name}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => removeDoc(cat.key, d.id)}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        <p className="text-xs text-muted-foreground">
          JPG, PNG or PDF, up to 4 MB each.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="rzp-reason">Reason (kept in the audit log)</Label>
          <Textarea
            id="rzp-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!ready || contest.isPending}
            onClick={() => contest.mutate("draft")}
          >
            Save draft
          </Button>
          <Button
            disabled={!ready || docCount === 0 || contest.isPending}
            onClick={() => contest.mutate("submit")}
          >
            Submit to Razorpay
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
