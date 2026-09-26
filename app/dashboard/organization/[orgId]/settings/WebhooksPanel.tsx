"use client";

/**
 * Settings › Webhooks — outbound webhook endpoints and their lifecycle.
 *
 * Visible on `integrations.manage` (OWNER + BILLING_ADMIN), the roles the
 * create/edit/redeliver routes admit (#1527 §17b). Rotating a secret and
 * deleting an endpoint are OWNER-only on the server, so only an owner sees
 * those two. Everything else was API-only before #1527 Q6.
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
import { PanelHeader } from "@/components/dashboard/PageScaffold";
import { Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { errorMessageFromBody } from "@/lib/fetch-helpers";
import { humanizeEnum, type Tone } from "@/lib/ui/tone";

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

type DeliveryRow = {
  id: string;
  eventType: string;
  status: string;
  httpStatusCode: number | null;
  attempts: number;
  lastError: string | null;
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

// #1762-4 — labels + tones instead of the raw enums.
const ENDPOINT_STATUS: Record<
  WebhookRow["status"],
  { label: string; tone: Tone }
> = {
  ACTIVE: { label: "Active", tone: "success" },
  PAUSED: { label: "Paused", tone: "caution" },
  DISABLED: { label: "Disabled", tone: "neutral" },
};

const DELIVERY_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "Queued", tone: "info" },
  SUCCESS: { label: "Delivered", tone: "success" },
  FAILED: { label: "Failed, retrying", tone: "caution" },
  DEAD_LETTER: { label: "Gave up", tone: "critical" },
};

const REDELIVERABLE = new Set(["SUCCESS", "FAILED", "DEAD_LETTER"]);

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

function lastDelivery(row: WebhookRow): string {
  if (row.lastSuccessAt) return new Date(row.lastSuccessAt).toLocaleString();
  if (row.lastFailureAt) {
    return `failed ${new Date(row.lastFailureAt).toLocaleString()}`;
  }
  return "—";
}

const webhookColumns: ResponsiveColumn<WebhookRow>[] = [
  {
    key: "url",
    header: "URL",
    primary: true,
    className: "max-w-xs truncate",
    cell: (row) => <code className="text-xs">{row.url}</code>,
  },
  {
    key: "status",
    header: "Status",
    cell: (row) => <StatusBadge {...ENDPOINT_STATUS[row.status]} />,
  },
  {
    key: "events",
    header: "Events",
    cell: (row) => (
      <span className="text-xs text-muted-foreground">
        {row.eventSubscriptions.join(", ")}
      </span>
    ),
  },
  {
    key: "failures",
    header: "Failures",
    className: "text-right tabular-nums",
    headClassName: "text-right",
    cell: (row) => row.failureCount,
  },
  {
    key: "lastDelivery",
    header: "Last delivery",
    className: "text-xs text-muted-foreground",
    cell: lastDelivery,
  },
];

function DeliveriesSheet({
  orgId,
  endpoint,
  onClose,
}: Readonly<{
  orgId: string;
  endpoint: WebhookRow | null;
  onClose: () => void;
}>) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const deliveries = useQuery({
    queryKey: ["org-webhook-deliveries", orgId, endpoint?.id],
    queryFn: async (): Promise<DeliveryRow[]> => {
      const json = await send(
        `/api/organizations/${orgId}/webhooks/${endpoint?.id}/deliveries?perPage=50`,
        "GET",
      );
      return (json as { data: DeliveryRow[] }).data;
    },
    enabled: endpoint !== null,
  });
  const redeliver = useMutation({
    mutationFn: (deliveryId: string) =>
      send(
        `/api/organizations/${orgId}/webhooks/${endpoint?.id}/deliveries/${deliveryId}/redeliver`,
        "POST",
      ),
    onSuccess: () => {
      toast({ title: "Queued for redelivery" });
      void qc.invalidateQueries({
        queryKey: ["org-webhook-deliveries", orgId, endpoint?.id],
      });
    },
    onError: (err: Error) =>
      toast({
        title: "Couldn't redeliver",
        description: err.message,
        variant: "destructive",
      }),
  });

  const columns: ResponsiveColumn<DeliveryRow>[] = [
    {
      key: "event",
      header: "Event",
      primary: true,
      cell: (d) => <code className="text-xs">{d.eventType}</code>,
    },
    {
      key: "status",
      header: "Status",
      cell: (d) => {
        const s = DELIVERY_STATUS[d.status];
        return (
          <StatusBadge
            label={s?.label ?? humanizeEnum(d.status)}
            tone={s?.tone ?? "neutral"}
          />
        );
      },
    },
    {
      key: "when",
      header: "Sent",
      className: "text-xs text-muted-foreground",
      cell: (d) =>
        `${new Date(d.createdAt).toLocaleString()} · ${d.attempts} ${d.attempts === 1 ? "try" : "tries"}${d.httpStatusCode ? ` · HTTP ${d.httpStatusCode}` : ""}`,
    },
  ];

  return (
    <Sheet open={endpoint !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-[480px]">
        <SheetHeader>
          <SheetTitle>Deliveries</SheetTitle>
          <SheetDescription className="break-all">
            {endpoint?.url}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-6">
          <ResponsiveTable<DeliveryRow>
            columns={columns}
            rows={deliveries.data ?? []}
            getRowId={(d) => d.id}
            isLoading={deliveries.isLoading}
            error={deliveries.isError ? "Couldn't load deliveries." : undefined}
            onRetry={() => void deliveries.refetch()}
            rowActions={(d) =>
              REDELIVERABLE.has(d.status) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={redeliver.isPending}
                  onClick={() => redeliver.mutate(d.id)}
                >
                  Redeliver
                </Button>
              ) : null
            }
            empty="Nothing has been sent to this endpoint yet."
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function WebhooksPanel({ orgId }: { orgId: string }) {
  const { allowed, isLoading: isGateLoading } = useRequireOrgAccess(orgId, {
    permission: "integrations.manage",
  });
  const { role } = useOrgRole(orgId);
  const isOwner = role === "OWNER";
  const qc = useQueryClient();
  const { toast } = useToast();

  const [url, setUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<Set<string>>(
    new Set(["invoice.issued"]),
  );
  // Secrets come back once (create or rotate) and are never refetched.
  const [shownSecret, setShownSecret] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<WebhookRow | null>(null);

  const list = useQuery({
    queryKey: ["org-webhooks", orgId],
    queryFn: async () => {
      const json = await send(`/api/organizations/${orgId}/webhooks`, "GET");
      return (json as { data: WebhookRow[] }).data;
    },
    enabled: allowed,
  });

  const create = useMutation({
    mutationFn: (payload: { url: string; eventSubscriptions: string[] }) =>
      send(`/api/organizations/${orgId}/webhooks`, "POST", payload),
    onSuccess: (json) => {
      setShownSecret(
        (json as { endpoint: { secret: string } }).endpoint.secret,
      );
      setUrl("");
      setSelectedEvents(new Set(["invoice.issued"]));
      setCreateError(null);
      void qc.invalidateQueries({ queryKey: ["org-webhooks", orgId] });
    },
    onError: (err: Error) => setCreateError(err.message),
  });

  if (isGateLoading || !allowed) return null;

  const rotate = async (row: WebhookRow) => {
    const json = await send(
      `/api/organizations/${orgId}/webhooks/${row.id}/rotate-secret`,
      "POST",
    );
    setShownSecret((json as { endpoint: { secret: string } }).endpoint.secret);
    toast({
      title: "Secret rotated",
      description: "The old secret keeps working for 24 hours.",
    });
  };

  const remove = async (row: WebhookRow) => {
    await send(`/api/organizations/${orgId}/webhooks/${row.id}`, "DELETE");
    void qc.invalidateQueries({ queryKey: ["org-webhooks", orgId] });
    toast({ title: "Endpoint deleted" });
  };

  const renderActions = (row: WebhookRow) => (
    <div className="flex items-center justify-end gap-1">
      <Button size="sm" variant="ghost" onClick={() => setDeliveriesFor(row)}>
        Deliveries
      </Button>
      {isOwner && (
        <ConfirmDialog
          title="Rotate the signing secret?"
          description="A new secret is issued and shown once. The old one keeps verifying for 24 hours so your receiver can switch over."
          confirmLabel="Rotate"
          onConfirm={() => rotate(row)}
          trigger={
            <Button size="sm" variant="ghost">
              Rotate secret
            </Button>
          }
        />
      )}
      {isOwner && (
        <ConfirmDialog
          title="Delete this endpoint?"
          description={`${row.url} stops receiving events immediately. This can't be undone.`}
          confirmLabel="Delete endpoint"
          tone="destructive"
          onConfirm={() => remove(row)}
          trigger={
            <Button size="sm" variant="ghost">
              Delete
            </Button>
          }
        />
      )}
    </div>
  );

  return (
    <>
      <PanelHeader description="Subscribe external systems to organization events. Receivers verify an HMAC-SHA256 signature on every delivery." />
      {shownSecret && (
        <div className="rounded-md border border-border bg-muted p-3">
          <p className="text-sm font-medium">
            Copy this signing secret now — it won&apos;t be shown again.
          </p>
          <code className="mt-2 block break-all rounded bg-card px-2 py-1 text-xs">
            {shownSecret}
          </code>
        </div>
      )}
      <Section title="Endpoints">
        {list.isError ? (
          <ErrorState
            title="Couldn't load endpoints"
            onRetry={() => void list.refetch()}
          />
        ) : (
          <ResponsiveTable<WebhookRow>
            columns={webhookColumns}
            rows={list.data ?? []}
            getRowId={(row) => row.id}
            isLoading={list.isLoading}
            rowActions={renderActions}
            empty="No webhook endpoints yet. Add one below."
          />
        )}
      </Section>
      <Section title="Add an endpoint" variant="card">
        <div className="max-w-3xl space-y-4">
          <div className="space-y-2">
            <Label htmlFor="webhook-url">Receiver URL (https://…)</Label>
            <Input
              id="webhook-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.your-system.example/familiarise-webhook"
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Events</legend>
            <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
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
          </fieldset>
          <FieldError message={createError} />
          <Button
            disabled={!url || selectedEvents.size === 0 || create.isPending}
            onClick={() =>
              create.mutate({
                url,
                eventSubscriptions: Array.from(selectedEvents),
              })
            }
          >
            {create.isPending ? "Adding…" : "Add endpoint"}
          </Button>
        </div>
      </Section>
      <DeliveriesSheet
        orgId={orgId}
        endpoint={deliveriesFor}
        onClose={() => setDeliveriesFor(null)}
      />
    </>
  );
}
