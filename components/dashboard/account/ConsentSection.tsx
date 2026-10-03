"use client";

import { useEffect } from "react";
import { Download } from "lucide-react";
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
  SIGNUP_PURPOSES,
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

interface PersonalConsentResponse {
  data: Artifact[];
  preferences?: {
    marketingEmails: boolean;
    cookieAnalytics: boolean;
    cookieMarketing: boolean;
  };
}

const OPTIONAL_PERSONAL_PURPOSES: readonly PurposeCode[] = [
  "MARKETING_COMMS",
  "ANALYTICS",
] as const;

/** An operator's record that you asked this org to stop (#1527 decision 5). */
interface WithdrawalRequest {
  id: string;
  purposeCode: PurposeCode;
  reason: string | null;
}

interface OrgConsent {
  data: Artifact[];
  withdrawalRequests?: WithdrawalRequest[];
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
const PERSONAL_CONSENT_KEY = "account-personal-consent";

/**
 * #1527 3c — Personal platform consent (Familiarise Two-Tier DPDP Consent +
 * §11 self-serve JSON data export) for every user, plus per-organisation
 * consent when the user belongs to one or more enterprise organisations.
 */
export function ConsentSection() {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const personalConsent = useQuery<PersonalConsentResponse>({
    queryKey: [PERSONAL_CONSENT_KEY],
    queryFn: async () => {
      const res = await fetch("/api/user/privacy/consent");
      if (!res.ok) throw new Error("Couldn't load your platform consent");
      return (await res.json()) as PersonalConsentResponse;
    },
    enabled: !!userId,
  });

  const personalChange = useMutation({
    mutationFn: async (vars: { purposeCode: PurposeCode; grant: boolean }) => {
      const res = vars.grant
        ? await fetch("/api/user/privacy/consent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              purposeCodes: [vars.purposeCode],
              language: "en-IN",
              version: 1,
            }),
          })
        : await fetch(
            `/api/user/privacy/consent?${new URLSearchParams({ purposeCode: vars.purposeCode })}`,
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
      await queryClient.invalidateQueries({ queryKey: [PERSONAL_CONSENT_KEY] });
      toast({ title: vars.grant ? "Consent given" : "Consent withdrawn" });
    },
    onError: (error) => {
      toast({
        title: "Couldn't update your consent",
        description: error.message,
        variant: "destructive",
      });
    },
  });

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
        return (await res.json()) as OrgConsent;
      },
      enabled: !!userId,
    })),
  });

  // The section loads after the page, so an anchored link lands short of it.
  const ready = memberships.isSuccess || personalConsent.isSuccess;
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

  const personalGranted = grantedPurposes(personalConsent.data?.data ?? []);
  if (personalConsent.data?.preferences?.marketingEmails) {
    personalGranted.add("MARKETING_COMMS");
  }
  if (personalConsent.data?.preferences?.cookieAnalytics) {
    personalGranted.add("ANALYTICS");
  }

  return (
    <Section
      id={DATA_CONSENT_ANCHOR}
      title="Data consent & privacy rights"
      description="Manage your DPDP Act 2023 data consents, download a machine-readable summary of your personal data and sub-processor sharing (§11), or withdraw core consent to close your account (§6(4) & §12)."
      variant="card"
    >
      <div className="space-y-6">
        {/* DPDP §11 Data Export + Core Withdrawal Action Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3.5">
          <div className="space-y-0.5">
            <p className="text-sm font-medium text-foreground">
              Your personal data &amp; processor sharing summary (DPDP §11)
            </p>
            <p className="text-xs text-muted-foreground">
              Download your profile, bookings, payments, consent history, and
              the list of Data Processors (Razorpay, GetStream, Novu, Resend,
              Sentry pseudonymous token) as JSON.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              asChild
              data-testid="download-personal-data-btn"
            >
              <a href="/api/user/privacy/export" download>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Download my data (JSON)
              </a>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() =>
                document
                  .getElementById("delete-account")
                  ?.scrollIntoView({ behavior: "smooth" })
              }
            >
              Withdraw core consent &amp; close account
            </Button>
          </div>
        </div>

        {/* Personal Platform Consent (Familiarise) */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">
            Familiarise platform consent
          </h3>
          <p className="text-xs text-muted-foreground">
            Core platform purposes (including pseudonymous security &amp; error
            telemetry via <code className="text-[11px]">ust_&lt;hash&gt;</code>{" "}
            under DPDP §8(5) &amp; Rule 6) are required while your account is
            open. Optional purposes can be toggled anytime in 1 click without
            affecting your bookings.
          </p>
          <ul className="divide-y divide-border">
            {SIGNUP_PURPOSES.map((code) => {
              const meta = PURPOSE_CODE_META[code];
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
                    <StatusBadge label="Required (Active)" tone="success" />
                  </div>
                </li>
              );
            })}
            {OPTIONAL_PERSONAL_PURPOSES.map((code) => {
              const meta = PURPOSE_CODE_META[code];
              const isGranted = personalGranted.has(code);
              const busy =
                personalChange.isPending &&
                personalChange.variables?.purposeCode === code;
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
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={personalConsent.isLoading || busy}
                      onClick={() =>
                        personalChange.mutate({
                          purposeCode: code,
                          grant: !isGranted,
                        })
                      }
                    >
                      {isGranted ? "Withdraw" : "Give consent"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Enterprise Organisation Consents */}
        {memberships.isError && (
          <p className="text-sm text-muted-foreground">
            We couldn&apos;t load your organisations. Refresh to try again.
          </p>
        )}
        {orgs.map((org, i) => {
          const query = consents[i];
          const granted = grantedPurposes(query?.data?.data ?? []);
          const requests = new Map(
            (query?.data?.withdrawalRequests ?? []).map((r) => [
              r.purposeCode,
              r,
            ]),
          );
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
                    const request = isGranted ? requests.get(code) : undefined;
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
                          {request && (
                            <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
                              {org.orgName} asked you to review your consent for{" "}
                              {meta.label.toLowerCase()}.
                              {request.reason && ` “${request.reason}”`} Only
                              you can withdraw it.
                            </p>
                          )}
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
