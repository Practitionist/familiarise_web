"use client";

/**
 * /dashboard/organization/[orgId]/integrations/webhooks
 *
 * BILLING_ADMIN-reachable surface for managing outbound webhook
 * endpoints. Listing + create-form + delivery-log link. Detail-pane
 * mutations (rotate-secret, delete) are intentionally GA follow-ups —
 * v1 hands the operator the curl recipes from
 * `docs/enterprise/29-outbound-webhooks.md` for the destructive paths.
 *
 * Gated via `useRequireFinanceSurface` so OWNER + MAINTAINER +
 * BILLING_ADMIN + MANAGER all reach it. MANAGER is read-only at the
 * API layer (the POST route requires OWNER+BILLING_ADMIN); the form
 * shows but submits surface a 403 with friendly copy.
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
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type WebhookRow = {
  id: string;
  url: string;
  status: "ACTIVE" | "PAUSED" | "DISABLED";
  eventSubscriptions: string[];
  failureCount: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  createdAt: string;
};

const ALL_EVENTS = [
  "member.added",
  "member.removed",
  "invoice.issued",
  "invoice.paid",
  "payout.completed",
  "payout.failed",
  "contract.signed",
  "program.assigned",
] as const;

const STATUS_TONE: Record<WebhookRow["status"], string> = {
  ACTIVE: "bg-emerald-50 text-emerald-700",
  PAUSED: "bg-amber-50 text-amber-700",
  DISABLED: "bg-zinc-200 text-zinc-700",
};

type PageProps = { params: Promise<{ orgId: string }> };

export default function WebhooksPage({ params }: Readonly<PageProps>) {
  const { orgId } = use(params);
  const { allowed, isLoading: isGateLoading } = useRequireFinanceSurface(orgId);
  const qc = useQueryClient();

  // Local form state. Kept here rather than React Hook Form because
  // the inputs are minimal (one URL + a checkbox list) and the
  // create path is one-shot — bringing RHF in would be overkill.
  const [url, setUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<Set<string>>(
    new Set(["invoice.issued"]),
  );
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["org-webhooks", orgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/webhooks`);
      if (!res.ok) throw new Error("Failed to load endpoints");
      const data = (await res.json()) as { data: WebhookRow[] };
      return data.data;
    },
    enabled: allowed,
  });

  const create = useMutation({
    mutationFn: async (payload: { url: string; eventSubscriptions: string[] }) => {
      const res = await fetch(`/api/organizations/${orgId}/webhooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? "Create failed");
      }
      return body.endpoint as WebhookRow & { secret: string };
    },
    onSuccess: (endpoint) => {
      // The raw secret comes back ONCE on POST — store it locally so we
      // can render the "copy now" affordance. We never refetch this
      // value; the list GET strips it.
      setCreatedSecret(endpoint.secret);
      setUrl("");
      setSelectedEvents(new Set(["invoice.issued"]));
      setCreateError(null);
      qc.invalidateQueries({ queryKey: ["org-webhooks", orgId] });
    },
    onError: (err) => setCreateError(err.message),
  });

  if (isGateLoading || !allowed) return null;

  return (
    <>
      <DashboardHeader
        title="Outbound webhooks"
        subtitle="Subscribe external systems to org lifecycle events. Receivers verify HMAC-SHA256 signatures on every delivery."
      />
      <DashboardContent>
        <Card>
          <CardHeader>
            <CardTitle>Create endpoint</CardTitle>
            <CardDescription>
              The signing secret is shown ONCE on create — copy it before
              navigating away. Rotate via the API if it's lost.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="webhook-url">Receiver URL (https://...)</Label>
              <Input
                id="webhook-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://api.your-system.example/familiarise-webhook"
              />
            </div>
            <div className="space-y-2">
              <Label>Subscribed events</Label>
              <div className="grid grid-cols-2 gap-2 text-sm">
                {ALL_EVENTS.map((ev) => (
                  <label key={ev} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedEvents.has(ev)}
                      onChange={(e) => {
                        const next = new Set(selectedEvents);
                        if (e.target.checked) next.add(ev);
                        else next.delete(ev);
                        setSelectedEvents(next);
                      }}
                    />
                    <code className="text-xs">{ev}</code>
                  </label>
                ))}
              </div>
            </div>
            {createError && (
              <p className="text-sm text-red-600">{createError}</p>
            )}
            {createdSecret && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
                <p className="text-sm font-medium text-emerald-900">
                  Endpoint created. Copy the secret now — it won&apos;t be
                  shown again.
                </p>
                <code className="mt-2 block break-all rounded bg-white px-2 py-1 text-xs">
                  {createdSecret}
                </code>
              </div>
            )}
            <Button
              disabled={!url || selectedEvents.size === 0 || create.isPending}
              onClick={() =>
                create.mutate({
                  url,
                  eventSubscriptions: Array.from(selectedEvents),
                })
              }
            >
              {create.isPending ? "Creating..." : "Create endpoint"}
            </Button>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Registered endpoints</CardTitle>
            <CardDescription>
              {list.data?.length ?? 0} endpoint
              {list.data?.length === 1 ? "" : "s"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {list.isLoading ? (
              <p className="text-sm text-zinc-500">Loading...</p>
            ) : !list.data || list.data.length === 0 ? (
              <p className="text-sm text-zinc-500">
                No webhook endpoints yet. Create one above to subscribe an
                external system to org lifecycle events.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>URL</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Events</TableHead>
                    <TableHead className="text-right">Failures</TableHead>
                    <TableHead>Last delivery</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="max-w-xs truncate">
                        <code className="text-xs">{row.url}</code>
                      </TableCell>
                      <TableCell>
                        <Badge className={STATUS_TONE[row.status]}>
                          {row.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-zinc-600">
                          {row.eventSubscriptions.join(", ")}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        {row.failureCount}
                      </TableCell>
                      <TableCell className="text-xs text-zinc-500">
                        {row.lastSuccessAt
                          ? new Date(row.lastSuccessAt).toLocaleString()
                          : row.lastFailureAt
                            ? `failed ${new Date(row.lastFailureAt).toLocaleString()}`
                            : "—"}
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
