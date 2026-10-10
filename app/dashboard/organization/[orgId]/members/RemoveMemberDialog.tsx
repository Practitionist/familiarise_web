"use client";

import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import type { MemberRow } from "@/schemas/organizations";
import {
  ApiResponseError,
  apiErrorSchema,
  parseJsonResponse,
} from "@/lib/fetch-helpers";
import { humanizeOrgError } from "@/lib/labels/org-errors";
import {
  REMOVAL_OBLIGATION_KEYS,
  REMOVAL_OBLIGATION_RESOLUTION,
  describeRemovalObligations,
  type RemovalObligationItem,
} from "@/lib/enterprise/removal-obligations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { fetchWithIdentity } from "@/lib/auth/identity-header";

const ObligationsResponseSchema = z.object({
  items: z.array(
    z.object({
      key: z.enum(REMOVAL_OBLIGATION_KEYS),
      count: z.number().int().positive(),
      label: z.string(),
    }),
  ),
});

const obligationsKey = (orgId: string, memberId: string) =>
  ["org-members", orgId, "remove-obligations", memberId] as const;

async function fetchObligations(
  orgId: string,
  memberId: string,
): Promise<RemovalObligationItem[]> {
  const res = await fetch(
    `/api/organizations/${orgId}/members/${memberId}/obligations`,
    { cache: "no-store" },
  );
  const body = await parseJsonResponse(
    res,
    ObligationsResponseSchema,
    "Couldn't check this member's open items",
  );
  return body.items;
}

async function deleteMember(orgId: string, memberId: string, force: boolean) {
  const res = await fetchWithIdentity(
    `/api/organizations/${orgId}/members/${memberId}${force ? "?force=true" : ""}`,
    { method: "DELETE" },
  );
  if (res.ok) return;
  const body: unknown = await res.json().catch(() => null);
  const envelope = apiErrorSchema.safeParse(body);
  const message = envelope.success ? envelope.data.error : undefined;
  throw new ApiResponseError(
    humanizeOrgError(message ?? "Failed to remove member"),
    {
      status: res.status,
      code: envelope.success ? envelope.data.code : undefined,
      fromServerBody: message !== undefined,
      body,
    },
  );
}

/** The per-key counts a `MEMBER_HAS_OBLIGATIONS` refusal carries. */
function refusalCounts(err: ApiResponseError): Record<string, number> {
  const parsed = z
    .object({ counts: z.record(z.string(), z.number()) })
    .safeParse(err.body);
  return parsed.success ? parsed.data.counts : {};
}

/**
 * #1854 — Remove member, with the removal guard's obligations shown before
 * the confirm. A non-OWNER cannot confirm while any are open; an OWNER can
 * force past them (#779 §C) after typing the member's email. The server guard
 * stays the authority: a refusal that lands anyway (a race) shows its own
 * message and counts here.
 */
export function RemoveMemberDialog({
  orgId,
  member,
  canForce,
  onClose,
}: Readonly<{
  orgId: string;
  member: MemberRow | null;
  /** OWNER only; the server refuses `?force=true` from anyone else. */
  canForce: boolean;
  onClose: () => void;
}>) {
  const queryClient = useQueryClient();
  const typedId = useId();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const memberId = member?.id ?? "";

  const obligations = useQuery({
    queryKey: obligationsKey(orgId, memberId),
    queryFn: () => fetchObligations(orgId, memberId),
    enabled: member !== null,
    staleTime: 0,
  });
  const items = obligations.data ?? [];
  const blocked = items.length > 0;
  const confirmWord = member?.user.email ?? "";

  const remove = useMutation({
    mutationFn: () => deleteMember(orgId, memberId, blocked && canForce),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
      onClose();
    },
    onError: (err: Error) => {
      setError(err.message);
      // A race: something opened after the read. Show what the guard counted.
      if (
        err instanceof ApiResponseError &&
        err.code === "MEMBER_HAS_OBLIGATIONS"
      ) {
        queryClient.setQueryData(
          obligationsKey(orgId, memberId),
          describeRemovalObligations(refusalCounts(err)),
        );
      }
    },
  });

  const confirmDisabled =
    remove.isPending ||
    obligations.isPending ||
    (blocked && (!canForce || typed !== confirmWord));

  return (
    <ResponsiveModal
      open={member !== null}
      onOpenChange={(open) => {
        if (!open && !remove.isPending) onClose();
      }}
    >
      <ResponsiveModalContent>
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Remove member?</ResponsiveModalTitle>
          <ResponsiveModalDescription>
            {member?.user.name ?? member?.user.email} will lose access to this
            organization immediately. You can re-invite them later.
          </ResponsiveModalDescription>
        </ResponsiveModalHeader>

        {obligations.isPending && (
          <p className="text-sm text-muted-foreground">
            Checking for upcoming sessions, seats and payments…
          </p>
        )}
        {obligations.isError && (
          <p className="text-sm text-muted-foreground">
            We couldn&apos;t check for open sessions, seats or payments. The
            removal will still be refused if any are open.
          </p>
        )}
        {blocked && (
          <div className="space-y-3 rounded-md border bg-muted/40 p-3 text-sm">
            <p className="font-medium text-foreground">
              This member still has open items here:
            </p>
            <ul className="space-y-2">
              {items.map((item) => (
                <li key={item.key}>
                  <span className="font-medium text-foreground">
                    {item.label}.
                  </span>{" "}
                  <span className="text-muted-foreground">
                    {REMOVAL_OBLIGATION_RESOLUTION[item.key]}
                  </span>
                </li>
              ))}
            </ul>
            {canForce ? (
              <p className="text-muted-foreground">
                As an Owner you can remove them anyway. Their live seats end
                now, everything else stays open, and the audit log records what
                was left.
              </p>
            ) : (
              <p className="text-muted-foreground">
                Resolve these first, or ask an Owner to remove them anyway.
              </p>
            )}
          </div>
        )}
        {blocked && canForce && (
          <div className="space-y-1.5">
            <Label htmlFor={typedId}>
              Type{" "}
              <span className="font-mono font-semibold">{confirmWord}</span> to
              remove them anyway
            </Label>
            <Input
              id={typedId}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={remove.isPending}
            />
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <ResponsiveModalFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={remove.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              setError(null);
              remove.mutate();
            }}
            disabled={confirmDisabled}
          >
            {remove.isPending && "Removing…"}
            {!remove.isPending &&
              (blocked && canForce ? "Remove anyway" : "Remove member")}
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
