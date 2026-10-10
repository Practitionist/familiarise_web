"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, ShieldAlert, Loader2 } from "lucide-react";

import { orgDetailsQueryKey } from "@/lib/api/organizations/org-details";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface SupportContactCardProps {
  orgId: string;
  version: number;
  initialSupportEmail: string | null | undefined;
  initialEscalationEmail: string | null | undefined;
  canEdit: boolean;
  onVersionConflict: () => void;
  onError: (msg: string | null) => void;
  onSuccess: () => void;
}

export function SupportContactCard({
  orgId,
  version,
  initialSupportEmail,
  initialEscalationEmail,
  canEdit,
  onVersionConflict,
  onError,
  onSuccess,
}: Readonly<SupportContactCardProps>) {
  const queryClient = useQueryClient();
  const [supportEmail, setSupportEmail] = useState(initialSupportEmail ?? "");
  const [escalationEmail, setEscalationEmail] = useState(
    initialEscalationEmail ?? "",
  );

  useEffect(() => {
    setSupportEmail(initialSupportEmail ?? "");
  }, [initialSupportEmail]);

  useEffect(() => {
    setEscalationEmail(initialEscalationEmail ?? "");
  }, [initialEscalationEmail]);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supportContactEmail: supportEmail.trim() || null,
          escalationContactEmail: escalationEmail.trim() || null,
          expectedVersion: version,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body?.code === "VERSION_CONFLICT") {
          throw Object.assign(new Error("VERSION_CONFLICT"), {
            code: "VERSION_CONFLICT",
          });
        }
        throw new Error(body?.error ?? "Failed to update support contacts");
      }
      return body;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-settings", orgId] });
      queryClient.invalidateQueries({ queryKey: orgDetailsQueryKey(orgId) });
      onError(null);
      onSuccess();
    },
    onError: (err) => {
      if (
        err instanceof Error &&
        "code" in err &&
        err.code === "VERSION_CONFLICT"
      ) {
        onVersionConflict();
        return;
      }
      onError(
        err instanceof Error ? err.message : "Failed to save support contacts",
      );
    },
  });

  const isDirty =
    supportEmail.trim() !== (initialSupportEmail ?? "") ||
    escalationEmail.trim() !== (initialEscalationEmail ?? "");

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="h-4 w-4" /> Support &amp; SLA Escalation Contacts
        </CardTitle>
        <CardDescription>
          Dedicated points of contact for organization-attributed support
          escalations and SLA breach notices.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="org-support-contact-email">
            Support contact email
          </Label>
          <Input
            id="org-support-contact-email"
            type="email"
            placeholder="helpdesk@yourcompany.com"
            value={supportEmail}
            onChange={(e) => setSupportEmail(e.target.value)}
            disabled={!canEdit || mutation.isPending}
          />
          <p className="text-xs text-zinc-500">
            Shown to Familiarise operators coordinating organization bookings
            and invoices.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label
            htmlFor="org-escalation-contact-email"
            className="flex items-center gap-1"
          >
            <ShieldAlert className="h-3.5 w-3.5 text-amber-600" /> Escalation
            alert email
          </Label>
          <Input
            id="org-escalation-contact-email"
            type="email"
            placeholder="ops-alerts@yourcompany.com"
            value={escalationEmail}
            onChange={(e) => setEscalationEmail(e.target.value)}
            disabled={!canEdit || mutation.isPending}
          />
          <p className="text-xs text-zinc-500">
            Notified when an organization-scoped support case breaches its
            acknowledgement or resolution target.
          </p>
        </div>
      </CardContent>
      {canEdit && (
        <CardFooter>
          <Button
            type="button"
            size="sm"
            disabled={!isDirty || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              "Save support contacts"
            )}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
