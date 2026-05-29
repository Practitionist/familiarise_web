"use client";

/**
 * /dashboard/organization/[orgId]/consent
 *
 * DPDP (Digital Personal Data Protection Act 2023) consent-artifact
 * dashboard. Lists this org's `ConsentArtifact`s (active + withdrawn
 * history) and lets an admin grant / withdraw consent on behalf of a
 * member. Withdrawal is exposed at exactly the same prominence as grant
 * — DPDP §6(4) requires that withdrawing consent be as easy as giving it.
 *
 * Gated via `useRequireFinanceSurface` so OWNER + MAINTAINER +
 * BILLING_ADMIN + MANAGER reach it (mirrors the DPDP data-exports sibling
 * and the MANAGER floor on /api/organizations/[orgId]/consent). Self-
 * service withdrawal from a member's own account settings is a separate
 * route (#681 follow-up); this is the org-admin compliance surface.
 *
 * Withdrawal is irreversible in our model: a re-grant goes through POST
 * and mints a NEW artifact with a fresh hash, keeping chain-of-custody
 * intact for auditors.
 */

import { use, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRequireFinanceSurface } from "../useOrgRole";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type ConsentArtifact = {
  id: string;
  userId: string;
  dataFiduciary: string;
  purposeCodes: string[];
  grantedAt: string;
  withdrawnAt: string | null;
  language: string;
  consentManager: string | null;
  version: number;
  hash: string;
};

type Member = {
  user: { id: string; name: string | null; email: string };
  role: string;
};

// Granular purpose taxonomy per the DPDP stub (lib/compliance/dpdp.ts).
// Free-form codes are still accepted by the API; this is the curated set
// the dashboard offers as one-click toggles.
const PURPOSE_CODES = [
  "session-booking",
  "marketing",
  "analytics",
  "third-party-sharing-with-stream",
] as const;

// Schedule VIII languages we surface in v1 (English + the most common
// Indian-enterprise locales). The API accepts any ISO 639-1/2 code.
const LANGUAGES: Array<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "hi", label: "हिन्दी (Hindi)" },
  { code: "bn", label: "বাংলা (Bengali)" },
  { code: "ta", label: "தமிழ் (Tamil)" },
  { code: "te", label: "తెలుగు (Telugu)" },
  { code: "mr", label: "मराठी (Marathi)" },
];

const NOTICE_VERSION = 1;

type PageProps = { params: Promise<{ orgId: string }> };

export default function ConsentPage({ params }: Readonly<PageProps>) {
  const { orgId } = use(params);
  const { allowed, isLoading: isGateLoading } = useRequireFinanceSurface(orgId);
  const qc = useQueryClient();

  // Grant-form state. Minimal local state (no RHF) — one member picker,
  // a purpose-code toggle list, and a language select.
  const [grantUserId, setGrantUserId] = useState("");
  const [grantPurposes, setGrantPurposes] = useState<Set<string>>(
    new Set(["session-booking"]),
  );
  const [grantLanguage, setGrantLanguage] = useState("en");
  const [actionError, setActionError] = useState<string | null>(null);

  const members = useQuery<Member[]>({
    queryKey: ["org-members", orgId, "consent-grant"],
    queryFn: async () => {
      const res = await fetch(
        `/api/organizations/${orgId}/members?perPage=100`,
      );
      if (!res.ok) throw new Error("Failed to load members");
      const body = (await res.json()) as { data: Member[] };
      return body.data;
    },
    enabled: allowed,
  });

  const consents = useQuery<ConsentArtifact[]>({
    queryKey: ["org-consents", orgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/consent?limit=200`);
      if (!res.ok) throw new Error("Failed to load consent artifacts");
      const body = (await res.json()) as { data: ConsentArtifact[] };
      return body.data;
    },
    enabled: allowed,
  });

  // Map userId → display label so the artifact table can show who the
  // data principal is without spelling out the raw id.
  const memberLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members.data ?? []) {
      map.set(m.user.id, m.user.name || m.user.email);
    }
    return map;
  }, [members.data]);

  const grant = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: grantUserId,
          purposeCodes: Array.from(grantPurposes),
          language: grantLanguage,
          version: NOTICE_VERSION,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to record consent");
      return body.consent as ConsentArtifact;
    },
    onSuccess: () => {
      setActionError(null);
      setGrantUserId("");
      setGrantPurposes(new Set(["session-booking"]));
      setGrantLanguage("en");
      qc.invalidateQueries({ queryKey: ["org-consents", orgId] });
    },
    onError: (err) => setActionError(err.message),
  });

  // Withdrawal scopes to a single purposeCode when provided; omitting it
  // is the full DPDP §12 opt-out. The DELETE endpoint is idempotent.
  const withdraw = useMutation({
    mutationFn: async (vars: { userId: string; purposeCode?: string }) => {
      const qs = new URLSearchParams({ userId: vars.userId });
      if (vars.purposeCode) qs.set("purposeCode", vars.purposeCode);
      const res = await fetch(
        `/api/organizations/${orgId}/consent?${qs.toString()}`,
        { method: "DELETE" },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to withdraw consent");
      return body as { withdrawnCount: number };
    },
    onSuccess: () => {
      setActionError(null);
      qc.invalidateQueries({ queryKey: ["org-consents", orgId] });
    },
    onError: (err) => setActionError(err.message),
  });

  if (isGateLoading || !allowed) return null;

  const togglePurpose = (code: string) => {
    setGrantPurposes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const rows = consents.data ?? [];
  const active = rows.filter((r) => r.withdrawnAt === null);
  const history = rows.filter((r) => r.withdrawnAt !== null);

  const canGrant =
    grantUserId !== "" && grantPurposes.size > 0 && !grant.isPending;

  return (
    <>
      <DashboardHeader
        title="DPDP consent"
        subtitle="Tamper-evident consent artifacts per the Digital Personal Data Protection Act 2023. Retained 7 years from grant or withdrawal."
      />
      <DashboardContent>
        {actionError && (
          <p className="mb-4 text-sm text-red-600">{actionError}</p>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Record consent</CardTitle>
            <CardDescription>
              Capture a member&apos;s consent for one or more processing
              purposes. Each grant mints a new hashed artifact; withdrawal is
              available below at the same prominence (DPDP §6(4)).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4 max-w-xl">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="consent-member">Member</Label>
                <Select value={grantUserId} onValueChange={setGrantUserId}>
                  <SelectTrigger id="consent-member">
                    <SelectValue
                      placeholder={
                        members.isLoading
                          ? "Loading members…"
                          : "Select a member"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {(members.data ?? []).map((m) => (
                      <SelectItem key={m.user.id} value={m.user.id}>
                        {m.user.name || m.user.email}
                        {m.user.name ? ` · ${m.user.email}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Purposes</Label>
                <div className="flex flex-wrap gap-2">
                  {PURPOSE_CODES.map((code) => {
                    const on = grantPurposes.has(code);
                    return (
                      <button
                        key={code}
                        type="button"
                        onClick={() => togglePurpose(code)}
                        className={
                          on
                            ? "rounded-full border border-primary bg-primary/10 px-3 py-1 text-xs font-medium text-primary"
                            : "rounded-full border border-input px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
                        }
                        aria-pressed={on}
                      >
                        {code}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="consent-language">Notice language</Label>
                <Select value={grantLanguage} onValueChange={setGrantLanguage}>
                  <SelectTrigger id="consent-language" className="sm:w-64">
                    <SelectValue placeholder="Language" />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGES.map((l) => (
                      <SelectItem key={l.code} value={l.code}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Button
                  disabled={!canGrant}
                  onClick={() => grant.mutate()}
                >
                  {grant.isPending ? "Recording…" : "Record consent"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Active consents</CardTitle>
            <CardDescription>
              Currently-granted artifacts. Withdraw a single purpose or all
              purposes for a member — withdrawal stamps the artifact and stops
              downstream processing.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Purposes</TableHead>
                  <TableHead>Language</TableHead>
                  <TableHead>Granted</TableHead>
                  <TableHead className="text-right">Withdraw</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {consents.isLoading ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="py-8 text-center text-zinc-500"
                    >
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : active.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="py-8 text-center text-zinc-500"
                    >
                      No active consent artifacts yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  active.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-sm">
                        {memberLabel.get(row.userId) ?? (
                          <span className="font-mono text-xs text-zinc-500">
                            {row.userId}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          {row.purposeCodes.map((p) => (
                            <Badge
                              key={p}
                              variant="secondary"
                              className="bg-emerald-50 text-emerald-700"
                            >
                              {p}
                              <button
                                type="button"
                                title={`Withdraw "${p}"`}
                                className="ml-1 text-emerald-700/70 hover:text-emerald-900"
                                disabled={withdraw.isPending}
                                onClick={() =>
                                  withdraw.mutate({
                                    userId: row.userId,
                                    purposeCode: p,
                                  })
                                }
                              >
                                ×
                              </button>
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs uppercase text-zinc-600">
                        {row.language}
                      </TableCell>
                      <TableCell className="text-xs text-zinc-600">
                        {new Date(row.grantedAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={withdraw.isPending}
                          onClick={() =>
                            withdraw.mutate({ userId: row.userId })
                          }
                        >
                          Withdraw all
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Withdrawal history</CardTitle>
            <CardDescription>
              Read-only record of withdrawn consents. Retained for the DPDP
              7-year audit window; a daily cron purges rows past retention.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Purposes</TableHead>
                  <TableHead>Granted</TableHead>
                  <TableHead>Withdrawn</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {consents.isLoading ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="py-8 text-center text-zinc-500"
                    >
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : history.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="py-8 text-center text-zinc-500"
                    >
                      No withdrawn consents.
                    </TableCell>
                  </TableRow>
                ) : (
                  history.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-sm">
                        {memberLabel.get(row.userId) ?? (
                          <span className="font-mono text-xs text-zinc-500">
                            {row.userId}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {row.purposeCodes.map((p) => (
                            <Badge
                              key={p}
                              variant="secondary"
                              className="bg-zinc-100 text-zinc-600"
                            >
                              {p}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-zinc-500">
                        {new Date(row.grantedAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs text-zinc-500">
                        {row.withdrawnAt
                          ? new Date(row.withdrawnAt).toLocaleString()
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge className="bg-rose-50 text-rose-700">
                          Withdrawn
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </DashboardContent>
    </>
  );
}
