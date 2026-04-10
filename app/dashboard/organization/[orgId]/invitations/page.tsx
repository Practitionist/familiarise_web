"use client";

import { use, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Trash2, Copy } from "lucide-react";
import { useRequireOrgRole } from "../useOrgRole";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  inviter: { id: string; name: string | null; email: string };
}

const ROLE_OPTIONS = [
  { value: "ORG_LEARNER", label: "Learner" },
  { value: "ORG_MANAGER", label: "Manager" },
  { value: "ORG_ADMIN", label: "Admin" },
  { value: "ORG_OWNER", label: "Owner" },
];

async function fetchInvitations(
  orgId: string,
): Promise<{ invitations: Invitation[] }> {
  const res = await fetch(`/api/organizations/${orgId}/invitations`);
  if (!res.ok) throw new Error("Failed to load invitations");
  return res.json();
}

async function createInvitation(
  orgId: string,
  payload: { email: string; role: string },
) {
  const res = await fetch(`/api/organizations/${orgId}/invitations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Failed to create invitation");
  return body;
}

async function revokeInvitation(orgId: string, invitationId: string) {
  const res = await fetch(
    `/api/organizations/${orgId}/invitations/${invitationId}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to revoke invitation");
  }
}

export default function OrgInvitationsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const { allowed } = useRequireOrgRole(orgId, "ORG_ADMIN");
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["org-invitations", orgId],
    queryFn: () => fetchInvitations(orgId),
  });

  const [showCreate, setShowCreate] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("ORG_LEARNER");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () => createInvitation(orgId, { email: email.trim(), role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-invitations", orgId] });
      setShowCreate(false);
      setEmail("");
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeInvitation(orgId, id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["org-invitations", orgId] }),
  });

  if (!allowed) return null;

  const copyInviteLink = (invitationId: string) => {
    const url = `${window.location.origin}/organizations/invite/${invitationId}`;
    navigator.clipboard.writeText(url);
  };

  return (
    <>
      <DashboardHeader
        title="Invitations"
        subtitle="Pending invitations to join this organization"
        actions={
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Mail className="h-4 w-4 mr-1" /> Invite by email
          </Button>
        }
      />
      <DashboardContent>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {isLoading
                ? "Loading…"
                : `${data?.invitations.length ?? 0} invitations`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="w-24">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data?.invitations.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell>{inv.email}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{inv.role}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            inv.status === "pending" ? "default" : "outline"
                          }
                        >
                          {inv.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-zinc-500">
                        {new Date(inv.expiresAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Copy invite link"
                            onClick={() => copyInviteLink(inv.id)}
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                          {inv.status === "pending" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Revoke invitation"
                              onClick={() => revokeMutation.mutate(inv.id)}
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {data && data.invitations.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center text-sm text-zinc-500 py-6"
                      >
                        No pending invitations.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </DashboardContent>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send invitation</DialogTitle>
            <DialogDescription>
              The recipient does not need an account yet — they will create
              one when accepting the invite.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="inv-email">Email</Label>
              <Input
                id="inv-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="alice@acme.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inv-role">Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id="inv-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || !email.includes("@")}
            >
              {createMutation.isPending ? "Sending…" : "Send invitation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
