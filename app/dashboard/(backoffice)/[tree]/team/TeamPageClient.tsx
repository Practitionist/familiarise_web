"use client";

/**
 * The Team page: everyone who can reach the console, whether they have
 * enrolled 2FA, and when they were last seen. ADMINs can add an operator and
 * reset a lost second factor; both buttons ask `can("users.moderate")`, the
 * same matrix the API enforces, so staff reading the roster see no buttons
 * that would 403.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

/** Mirrors GET /api/admin/team/members. */
interface MemberRow {
  id: string;
  name: string | null;
  email: string;
  role: "STAFF" | "ADMIN";
  banned: boolean | null;
  twoFactorEnabled: boolean;
  lastActiveAt: string | null;
}

type Role = MemberRow["role"];

async function call(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json" },
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? "That action could not be completed.");
  }
  return payload;
}

export function TeamPageClient() {
  const { can, viewerId } = useBackofficeCapability();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const mayManage = can("users.moderate");

  const [addOpen, setAddOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("STAFF");
  const [addReason, setAddReason] = useState("");

  const [resetTarget, setResetTarget] = useState<MemberRow | null>(null);
  const [resetReason, setResetReason] = useState("");

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ["team"],
    queryFn: async (): Promise<{ members: MemberRow[] }> => {
      const response = await fetch("/api/admin/team/members");
      if (!response.ok) throw new Error("Failed to load the team roster");
      return response.json();
    },
  });
  const members = data?.members ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["team"] });
  const fail = (title: string) => (cause: Error) =>
    toast({ title, description: cause.message, variant: "destructive" });

  const add = useMutation({
    mutationFn: () =>
      call("/api/admin/team/members", {
        method: "POST",
        body: JSON.stringify({ email, name, role, reason: addReason }),
      }) as Promise<{ setupLinkSent?: boolean }>,
    onSuccess: (result) => {
      toast({
        title: "Account created",
        description: result.setupLinkSent
          ? `${email} has been emailed a link to set their password. It expires in 30 minutes; they can request another with "Forgot password".`
          : `The email did not send. Ask ${email} to use "Forgot password" on the sign-in page.`,
      });
      setAddOpen(false);
      setEmail("");
      setName("");
      setAddReason("");
      void refresh();
    },
    onError: fail("Could not add that person"),
  });

  const resetTwoFactor = useMutation({
    mutationFn: (target: MemberRow) =>
      call(`/api/admin/team/members/${target.id}/two-factor`, {
        method: "DELETE",
        body: JSON.stringify({ reason: resetReason }),
      }),
    onSuccess: () => {
      toast({
        title: "Two-factor reset",
        description:
          "They have been signed out and will set up a new authenticator at their next sign-in.",
      });
      setResetTarget(null);
      setResetReason("");
      void refresh();
    },
    onError: fail("Could not reset two-factor"),
  });

  const columns: ResponsiveColumn<MemberRow>[] = [
    {
      key: "person",
      header: "Name",
      primary: true,
      cell: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-foreground">
            {row.name || "Unnamed"}
            {row.id === viewerId ? (
              <span className="ml-2 text-xs text-muted-foreground">(you)</span>
            ) : null}
            {row.banned ? (
              <span className="ml-2 text-xs text-destructive">suspended</span>
            ) : null}
          </p>
          <p className="text-sm text-muted-foreground">{row.email}</p>
        </div>
      ),
    },
    { key: "role", header: "Role", cell: (row) => row.role },
    {
      key: "twofa",
      header: "2FA",
      cell: (row) =>
        row.twoFactorEnabled ? (
          <StatusBadge label="Yes" tone="success" variant="dot" />
        ) : (
          <StatusBadge label="No" tone="caution" variant="dot" />
        ),
    },
    {
      key: "lastActive",
      header: "Last active",
      className: "text-sm text-muted-foreground",
      cell: (row) =>
        row.lastActiveAt
          ? new Date(row.lastActiveAt).toLocaleDateString()
          : "Never",
    },
    ...(mayManage
      ? [
          {
            key: "actions",
            header: "",
            cell: (row: MemberRow) =>
              row.twoFactorEnabled ? (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setResetTarget(row)}
                  >
                    Reset 2FA
                  </Button>
                </div>
              ) : null,
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team"
        description="Everyone who can reach this console. Staff sign in with a password and an authenticator app."
      />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">
            Members ({members.length})
          </h2>
          {mayManage ? (
            <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
              Add staff
            </Button>
          ) : null}
        </div>
        <ResponsiveTable<MemberRow>
          columns={columns}
          rows={members}
          getRowId={(row) => row.id}
          isLoading={isPending && !data}
          error={error && !data ? error : undefined}
          onRetry={() => void refetch()}
          empty={
            <p className="py-10 text-center text-sm text-muted-foreground">
              No staff on this deployment yet.
            </p>
          }
        />
      </section>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add staff</DialogTitle>
            <DialogDescription>
              They get an email to set their password, then set up two-factor
              authentication at their first sign-in.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="member-email">Email address</Label>
              <Input
                id="member-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="colleague@example.com"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="member-name">Full name</Label>
              <Input
                id="member-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="member-role">Role</Label>
              <Select
                value={role}
                onValueChange={(value) =>
                  setRole(value === "ADMIN" ? "ADMIN" : "STAFF")
                }
              >
                <SelectTrigger id="member-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="STAFF">
                    Staff: support, tickets, read-only money
                  </SelectItem>
                  <SelectItem value="ADMIN">
                    Administrator: refunds, payouts, accounts
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <ReasonField
              id="add-reason"
              value={addReason}
              onChange={setAddReason}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAddOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                add.isPending ||
                !email.trim() ||
                !name.trim() ||
                addReason.trim().length < 5
              }
              onClick={() => add.mutate()}
            >
              {add.isPending ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={resetTarget !== null}
        onOpenChange={(open) => !open && setResetTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Reset two-factor for {resetTarget?.email}?
            </DialogTitle>
            <DialogDescription>
              Their authenticator and backup codes stop working and they are
              signed out everywhere. Whoever signs in next with their password
              enrols a new authenticator, so confirm who you are talking to
              before you do this.
            </DialogDescription>
          </DialogHeader>
          <ReasonField
            id="reset-reason"
            value={resetReason}
            onChange={setResetReason}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setResetTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={
                resetTwoFactor.isPending || resetReason.trim().length < 5
              }
              onClick={() => resetTarget && resetTwoFactor.mutate(resetTarget)}
            >
              {resetTwoFactor.isPending ? "Resetting…" : "Reset 2FA"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ReasonField(props: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={props.id}>Reason (recorded in the audit log)</Label>
      <Textarea
        id={props.id}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        rows={2}
      />
    </div>
  );
}
