"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import { useToast } from "@/hooks/use-toast";
import { errorMessageFromBody } from "@/lib/fetch-helpers";

interface DomainClaim {
  id: string;
  domain: string;
  verificationToken: string | null;
  verifiedAt: string | null;
  claimedAt: string;
}

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorMessageFromBody(json, "That didn't work."));
  return json;
}

function TxtInstructions({ claim }: Readonly<{ claim: DomainClaim }>) {
  return (
    <div className="mt-2 space-y-1 rounded-md border border-border bg-muted p-3 text-xs">
      <p>
        Add this TXT record at your DNS provider, then choose Verify. DNS
        changes can take a few minutes to appear.
      </p>
      <p>
        Name:{" "}
        <code className="break-all">_familiarise-verify.{claim.domain}</code>
      </p>
      <p>
        Value: <code className="break-all">{claim.verificationToken}</code>
      </p>
    </div>
  );
}

/**
 * Settings › Domains (#1527 Q6): claim an email domain, prove it with a DNS
 * TXT record, and remove it. A verified domain unlocks SSO, invoice funding
 * and seats past the unverified cap (lib/enterprise/governance.ts). OWNER-only
 * on the server and in the tab.
 */
export function DomainsPanel({ orgId }: Readonly<{ orgId: string }>) {
  const [domain, setDomain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const base = `/api/organizations/${orgId}/domain-claims`;
  const key = ["org-domain-claims", orgId];

  const claims = useQuery({
    queryKey: key,
    queryFn: async (): Promise<DomainClaim[]> =>
      ((await send(base, "GET")) as { data: DomainClaim[] }).data,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  const claim = useMutation({
    mutationFn: () =>
      send(base, "POST", { domain: domain.trim().toLowerCase() }),
    onSuccess: async () => {
      setDomain("");
      setError(null);
      await refresh();
    },
    onError: (err: Error) => setError(err.message),
  });

  const verify = useMutation({
    mutationFn: (d: string) =>
      send(`${base}/${encodeURIComponent(d)}/verify`, "POST"),
    onSuccess: async (_json, d) => {
      toast({ title: "Domain verified", description: `${d} is now yours.` });
      await refresh();
    },
    onError: (err: Error) =>
      toast({
        title: "Not verified yet",
        description: err.message,
        variant: "destructive",
      }),
  });

  let list: React.ReactNode;
  if (claims.isPending) {
    list = <p className="text-sm text-muted-foreground">Loading…</p>;
  } else if (claims.isError) {
    list = (
      <ErrorState
        title="Couldn't load domains"
        onRetry={() => void claims.refetch()}
      />
    );
  } else if (claims.data.length === 0) {
    list = (
      <p className="text-sm text-muted-foreground">
        No domains yet. Claim the domain your members&apos; email addresses use.
      </p>
    );
  } else {
    list = (
      <ul className="divide-y divide-border rounded-lg border border-border">
        {claims.data.map((c) => (
          <li key={c.id} className="px-3 py-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <span className="font-medium">{c.domain}</span>
                {c.verifiedAt ? (
                  <StatusBadge label="Verified" tone="success" size="sm" />
                ) : (
                  <StatusBadge
                    label="Waiting for DNS"
                    tone="warning"
                    size="sm"
                  />
                )}
              </span>
              <span className="flex gap-1">
                {!c.verifiedAt && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={verify.isPending}
                    onClick={() => verify.mutate(c.domain)}
                  >
                    Verify
                  </Button>
                )}
                <ConfirmDialog
                  title={`Remove ${c.domain}?`}
                  description="Single sign-on and automatic joining stop working for this domain straight away."
                  confirmLabel="Remove domain"
                  tone="destructive"
                  onConfirm={async () => {
                    await send(
                      `${base}/${encodeURIComponent(c.domain)}`,
                      "DELETE",
                    );
                    await refresh();
                  }}
                  trigger={
                    <Button size="sm" variant="ghost">
                      Remove
                    </Button>
                  }
                />
              </span>
            </div>
            {!c.verifiedAt && c.verificationToken && (
              <TxtInstructions claim={c} />
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Section
      title="Domains"
      description="Verifying a domain proves your organization controls it. It unlocks single sign-on and invoice funding."
    >
      {list}
      <form
        className="mt-4 flex max-w-xl flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (domain.trim()) claim.mutate();
        }}
      >
        <div className="min-w-56 flex-1 space-y-1.5">
          <Label htmlFor="domain-claim">Domain</Label>
          <Input
            id="domain-claim"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="acme.com"
          />
        </div>
        <Button type="submit" disabled={claim.isPending || !domain.trim()}>
          {claim.isPending ? "Claiming…" : "Claim domain"}
        </Button>
      </form>
      <FieldError message={error} />
    </Section>
  );
}
