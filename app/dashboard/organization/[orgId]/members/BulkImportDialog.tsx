"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { FieldError } from "@/components/ui/field-error";
import { errorMessageFromBody } from "@/lib/fetch-helpers";
import { humanizeOrgError } from "@/lib/labels/org-errors";

interface ImportResult {
  imported: number;
  failed: number;
  results: { email: string; ok: boolean; error?: string }[];
}

/** The route caps a batch at 200 entries. */
const MAX_ENTRIES = 200;

/** "email, name" per line; a header row or blank lines are skipped. */
function parseBulkEntries(text: string): { email: string; name: string }[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split(",").map((part) => part.trim()))
    .filter(([email]) => email?.includes("@"))
    .map(([email, ...rest]) => ({
      email,
      name: rest.join(",").trim() || email.split("@")[0],
    }));
}

/**
 * Invitations › Bulk import (#1527 Q6): up to 200 learners at once through
 * `POST …/members/bulk-import`, which creates LEARNER memberships and emails
 * each person. MAINTAINER+ on the server.
 */
export function BulkImportDialog({ orgId }: Readonly<{ orgId: string }>) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const queryClient = useQueryClient();
  const entries = parseBulkEntries(text);

  const mutation = useMutation({
    mutationFn: async (): Promise<ImportResult> => {
      const res = await fetch(
        `/api/organizations/${orgId}/members/bulk-import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries }),
        },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          humanizeOrgError(errorMessageFromBody(body, "Import failed.")),
        );
      }
      return body as ImportResult;
    },
    onSuccess: (data) => {
      setResult(data);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const close = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setText("");
      setResult(null);
      setError(null);
    }
  };

  const failures = result?.results.filter((r) => !r.ok) ?? [];

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Upload className="mr-1 h-4 w-4" /> Bulk import
      </Button>
      <ResponsiveModal open={open} onOpenChange={close}>
        <ResponsiveModalContent className="sm:max-w-lg">
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>Bulk import learners</ResponsiveModalTitle>
            <ResponsiveModalDescription>
              Paste one person per line as &quot;email, name&quot;, up to{" "}
              {MAX_ENTRIES} at a time. Everyone joins as a learner and gets an
              email.
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>
          {result ? (
            <div className="space-y-2 text-sm">
              <p>
                Imported {result.imported}
                {result.failed > 0
                  ? `; ${result.failed} could not be added.`
                  : "."}
              </p>
              {failures.length > 0 && (
                <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                  {failures.map((f) => (
                    <li key={f.email}>
                      {f.email}: {humanizeOrgError(f.error ?? "Not added")}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="bulk-import-entries">People</Label>
              <Textarea
                id="bulk-import-entries"
                rows={8}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  "alice@acme.com, Alice Rao\nbob@acme.com, Bob Iyer"
                }
              />
              <p className="text-xs text-muted-foreground">
                {entries.length} {entries.length === 1 ? "person" : "people"}{" "}
                ready to import.
              </p>
              <FieldError
                message={
                  entries.length > MAX_ENTRIES
                    ? `Split this into batches of ${MAX_ENTRIES} or fewer.`
                    : error
                }
              />
            </div>
          )}
          <ResponsiveModalFooter>
            <Button variant="outline" onClick={() => close(false)}>
              {result ? "Done" : "Cancel"}
            </Button>
            {!result && (
              <Button
                onClick={() => mutation.mutate()}
                disabled={
                  mutation.isPending ||
                  entries.length === 0 ||
                  entries.length > MAX_ENTRIES
                }
              >
                {mutation.isPending ? "Importing…" : "Import"}
              </Button>
            )}
          </ResponsiveModalFooter>
        </ResponsiveModalContent>
      </ResponsiveModal>
    </>
  );
}
