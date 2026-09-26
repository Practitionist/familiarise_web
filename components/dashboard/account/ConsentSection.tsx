"use client";

import { useEffect } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { useToast } from "@/hooks/use-toast";
import { useSession } from "@/lib/auth-client";
import { DATA_CONSENT_ANCHOR } from "@/lib/dashboard/account-href";
import {
  ALL_PURPOSE_CODES,
  PURPOSE_CODE_META,
  normalizePurposeCode,
  type PurposeCode,
} from "@/lib/compliance/purpose-codes";

interface OrgMembership {
  organizationId: string;
  orgName: string;
}

interface Artifact {
  purposeCodes: string[];
  withdrawnAt: string | null;
  auditRetainedUntil: string;
}

/** Same predicate as checkConsent: live, not withdrawn, carrying the purpose. */
function grantedPurposes(artifacts: Artifact[]): Set<PurposeCode> {
  const now = Date.now();
  const granted = new Set<PurposeCode>();
  for (const a of artifacts) {
    if (a.withdrawnAt || Date.parse(a.auditRetainedUntil) <= now) continue;
    for (const raw of a.purposeCodes) {
      const code = normalizePurposeCode(raw);
      if (code) granted.add(code);
    }
  }
  return granted;
}

const CONSENT_KEY = "account-org-consent";

/**
 * #1527 3c — operators can no longer grant consent for a member (decision 5),
 * so this is the member's own Grant / Withdraw for each organisation they
 * belong to, through that org's consent route (self-only for non-operators).
 * Checkout's CONSENT_REQUIRED links here via `dataConsentHref`.
 */
export function ConsentSection() {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const memberships = useQuery<OrgMembership[]>({
    queryKey: ["account-org-memberships"],
    queryFn: async () => {
      const res = await fetch("/api/user/org-memberships");
      if (!res.ok) throw new Error("Couldn't load your organisations");
      return ((await res.json()) as { data: OrgMembership[] }).data;
    },
    enabled: !!userId,
  });
  const orgs = memberships.data ?? [];

  const consents = useQueries({
    queries: orgs.map((org) => ({
      queryKey: [CONSENT_KEY, org.organizationId],
      queryFn: async () => {
        const qs = new URLSearchParams({ userId: userId ?? "", limit: "200" });
        const res = await fetch(
          `/api/organizations/${org.organizationId}/consent?${qs}`,
        );
        if (!res.ok) throw new Error("Couldn't load your consent");
        return ((await res.json()) as { data: Artifact[] }).data;
      },
      enabled: !!userId,
    })),
  });

  // The section loads after the page, so an anchored link lands short of it.
  const ready = memberships.isSuccess;
  useEffect(() => {
    if (ready && window.location.hash === `#${DATA_CONSENT_ANCHOR}`) {
      document.getElementById(DATA_CONSENT_ANCHOR)?.scrollIntoView();
    }
  }, [ready]);

  const change = useMutation({
    mutationFn: async (vars: {
      orgId: string;
      purposeCode: PurposeCode;
      grant: boolean;
    }) => {
      const base = `/api/organizations/${vars.orgId}/consent`;
      const res = vars.grant
        ? await fetch(base, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              purposeCodes: [vars.purposeCode],
              language: "en-IN",
              version: 1,
            }),
          })
        : await fetch(
            `${base}?${new URLSearchParams({ userId: userId ?? "", purposeCode: vars.purposeCode })}`,
            { method: "DELETE" },
          );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? "Please try again.");
      }
    },
    onSuccess: async (_data, vars) => {
      // Consent is checked per person, not per organisation, so every row moves.
      await queryClient.invalidateQueries({ queryKey: [CONSENT_KEY] });
      toast({ title: vars.grant ? "Consent given" : "Consent withdrawn" });
    },
  });

  return (
    <Section
      id={DATA_CONSENT_ANCHOR}
      title="Data consent"
      description="Your organisations can only book sessions for you, or share your data for these purposes, while you consent. A withdrawal applies to every organisation you belong to."
      variant="card"
    >
      {memberships.isError && (
        <p className="text-sm text-muted-foreground">
          We couldn&apos;t load your organisations. Refresh to try again.
        </p>
      )}
      {memberships.isSuccess && orgs.length === 0 && (
        <p className="text-sm text-muted-foreground">
          You don&apos;t belong to an organisation, so there is no organisation
          consent to manage.
        </p>
      )}
      <div className="space-y-6">
        {orgs.map((org, i) => {
          const query = consents[i];
          const granted = grantedPurposes(query?.data ?? []);
          return (
            <div key={org.organizationId} className="space-y-2">
              <h3 className="text-sm font-medium text-foreground">
                {org.orgName}
              </h3>
              {query?.isError ? (
                <p className="text-sm text-muted-foreground">
                  We couldn&apos;t load your consent for this organisation.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {ALL_PURPOSE_CODES.map((code) => {
                    const meta = PURPOSE_CODE_META[code];
                    const isGranted = granted.has(code);
                    const busy =
                      change.isPending &&
                      change.variables?.orgId === org.organizationId &&
                      change.variables.purposeCode === code;
                    return (
                      <li
                        key={code}
                        className="flex items-center justify-between gap-4 py-3"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">
                            {meta.label}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {meta.description}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          <StatusBadge
                            label={isGranted ? "Given" : "Not given"}
                            tone={isGranted ? "success" : "neutral"}
                          />
                          {isGranted ? (
                            <ConfirmDialog
                              trigger={
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={query?.isLoading || busy}
                                >
                                  Withdraw
                                </Button>
                              }
                              title={`Withdraw consent for ${meta.label.toLowerCase()}?`}
                              description="Every organisation you belong to stops relying on it until you give it again."
                              confirmLabel="Withdraw"
                              tone="destructive"
                              onConfirm={() =>
                                change.mutateAsync({
                                  orgId: org.organizationId,
                                  purposeCode: code,
                                  grant: false,
                                })
                              }
                            />
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={query?.isLoading || busy}
                              onClick={() =>
                                change.mutate(
                                  {
                                    orgId: org.organizationId,
                                    purposeCode: code,
                                    grant: true,
                                  },
                                  {
                                    // Withdraw errors show in its dialog.
                                    onError: (error) =>
                                      toast({
                                        title: "Couldn't give your consent",
                                        description: error.message,
                                        variant: "destructive",
                                      }),
                                  },
                                )
                              }
                            >
                              Give consent
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}
