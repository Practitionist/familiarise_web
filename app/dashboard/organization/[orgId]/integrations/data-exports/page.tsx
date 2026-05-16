"use client";

/**
 * /dashboard/organization/[orgId]/integrations/data-exports
 *
 * DPDP §11 right-to-access surface. OWNER + BILLING_ADMIN can request
 * a bundle (rate-limited 1/24h via `orgDataExportLimiter`); the worker
 * picks it up within ~10 minutes, uploads to Supabase Storage, and
 * the dashboard exposes a download link with a 7-day signed-URL TTL.
 *
 * Refresh-on-poll: while a request is PENDING / PROCESSING, the page
 * refetches every 15 seconds. We stop polling on terminal states
 * (READY / FAILED / EXPIRED) to keep the dashboard idle.
 */

import { use, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRequireFinanceSurface } from "../../useOrgRole";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type ExportJob = {
  id: string;
  status: "PENDING" | "PROCESSING" | "READY" | "FAILED" | "EXPIRED";
  requestedByMembershipId: string;
  fileSizeBytes: number | string | null;
  expiresAt: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

const STATUS_TONE: Record<ExportJob["status"], string> = {
  PENDING: "bg-amber-50 text-amber-700",
  PROCESSING: "bg-blue-50 text-blue-700",
  READY: "bg-emerald-50 text-emerald-700",
  FAILED: "bg-red-50 text-red-700",
  EXPIRED: "bg-zinc-200 text-zinc-700",
};

type PageProps = { params: Promise<{ orgId: string }> };

export default function DataExportsPage({ params }: Readonly<PageProps>) {
  const { orgId } = use(params);
  const { allowed, isLoading: isGateLoading } = useRequireFinanceSurface(orgId);
  const qc = useQueryClient();
  const [requestError, setRequestError] = useState<string | null>(null);

  const list = useQuery<ExportJob[]>({
    queryKey: ["org-data-exports", orgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/data-exports`);
      if (!res.ok) throw new Error("Failed to load exports");
      const body = (await res.json()) as { data: ExportJob[] };
      return body.data;
    },
    enabled: allowed,
    // Refetch while any row is still being worked on. Stops polling
    // once every row is READY / FAILED / EXPIRED.
    refetchInterval: (q) => {
      const rows = q.state.data;
      if (!rows) return false;
      const inFlight = rows.some(
        (r) => r.status === "PENDING" || r.status === "PROCESSING",
      );
      return inFlight ? 15_000 : false;
    },
  });

  const request = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/data-exports`, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(
          body.error ?? "Export request failed — try again in 24 hours",
        );
      }
      return body.export as ExportJob;
    },
    onSuccess: () => {
      setRequestError(null);
      qc.invalidateQueries({ queryKey: ["org-data-exports", orgId] });
    },
    onError: (err) => setRequestError(err.message),
  });

  async function download(exportId: string) {
    const res = await fetch(
      `/api/organizations/${orgId}/data-exports/${exportId}/download`,
    );
    const body = await res.json();
    if (!res.ok) {
      setRequestError(body.error ?? "Download URL unavailable");
      return;
    }
    // Open in a new tab so the dashboard stays put — the signed URL
    // is single-use-from-the-CDN-perspective but multi-fetchable
    // within the 7-day window.
    window.open(body.url, "_blank", "noopener");
  }

  if (isGateLoading || !allowed) return null;

  return (
    <>
      <DashboardHeader
        title="Data exports"
        description="Download a JSON bundle of every entity scoped to this org — members, contracts, programs, invoices, earnings, payouts, audit log. Honours DPDP §11."
      />
      <DashboardContent>
        <Card>
          <CardHeader>
            <CardTitle>Request a bundle</CardTitle>
            <CardDescription>
              One request per organization per 24 hours. Bundles are emailed
              when ready and expire 7 days after generation. See{" "}
              <a
                href="/docs/enterprise/33-data-export"
                className="underline"
                target="_blank"
                rel="noreferrer"
              >
                Data export docs
              </a>{" "}
              for the bundle schema.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {requestError && (
              <p className="mb-3 text-sm text-red-600">{requestError}</p>
            )}
            <Button
              disabled={request.isPending}
              onClick={() => request.mutate()}
            >
              {request.isPending ? "Requesting..." : "Request export"}
            </Button>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Past exports</CardTitle>
            <CardDescription>
              Last 30 days. Polls every 15 seconds while anything is in
              flight.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {list.isLoading ? (
              <p className="text-sm text-zinc-500">Loading...</p>
            ) : !list.data || list.data.length === 0 ? (
              <p className="text-sm text-zinc-500">
                No exports yet. Click &quot;Request export&quot; above.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Requested</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-xs text-zinc-600">
                        {new Date(row.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Badge className={STATUS_TONE[row.status]}>
                          {row.status}
                        </Badge>
                        {row.error && (
                          <p className="mt-1 text-xs text-red-600">
                            {row.error}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs text-zinc-600">
                        {row.fileSizeBytes
                          ? `${(Number(row.fileSizeBytes) / 1024).toFixed(1)} KB`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-zinc-500">
                        {row.expiresAt
                          ? new Date(row.expiresAt).toLocaleString()
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.status === "READY" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => download(row.id)}
                          >
                            Download
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </DashboardContent>
    </>
  );
}
