"use client";

import { use, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Trash2 } from "lucide-react";

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

interface MemberRow {
  id: string;
  memberId: string;
  role: string;
  status: string;
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  };
}

const SELECTABLE_ROLES = [
  { value: "ORG_OWNER", label: "Owner" },
  { value: "ORG_ADMIN", label: "Admin" },
  { value: "ORG_MANAGER", label: "Manager" },
  { value: "ORG_LEARNER", label: "Learner" },
];

async function fetchMembers(orgId: string): Promise<{ members: MemberRow[] }> {
  const res = await fetch(`/api/organizations/${orgId}/members`);
  if (!res.ok) throw new Error("Failed to load members");
  return res.json();
}

async function addMember(
  orgId: string,
  payload: { email: string; role: string },
) {
  const res = await fetch(`/api/organizations/${orgId}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Failed to add member");
  return body;
}

async function removeMember(orgId: string, memberId: string) {
  const res = await fetch(
    `/api/organizations/${orgId}/members/${memberId}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to remove member");
  }
}

export default function OrgMembersPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["org-members", orgId],
    queryFn: () => fetchMembers(orgId),
  });

  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("ORG_LEARNER");
  const [error, setError] = useState<string | null>(null);

  const addMutation = useMutation({
    mutationFn: () => addMember(orgId, { email: email.trim(), role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
      setShowInvite(false);
      setEmail("");
      setRole("ORG_LEARNER");
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const removeMutation = useMutation({
    mutationFn: (memberId: string) => removeMember(orgId, memberId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] }),
  });

  return (
    <>
      <DashboardHeader
        title="Members"
        subtitle="Everyone with a seat in this organization"
        actions={
          <Button size="sm" onClick={() => setShowInvite(true)}>
            <UserPlus className="h-4 w-4 mr-1" /> Add member
          </Button>
        }
      />
      <DashboardContent>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {isLoading
                ? "Loading…"
                : `${data?.members.length ?? 0} members`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Member</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data?.members.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium text-zinc-900">
                            {m.user.name ?? "—"}
                          </span>
                          <span className="text-xs text-zinc-500">
                            {m.user.email}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{m.role}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            m.status === "ACTIVE" ? "default" : "outline"
                          }
                        >
                          {m.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Remove member"
                          onClick={() => removeMutation.mutate(m.id)}
                          disabled={removeMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {data && data.members.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="text-center text-sm text-zinc-500 py-6"
                      >
                        No members yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </DashboardContent>

      <Dialog open={showInvite} onOpenChange={setShowInvite}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add member</DialogTitle>
            <DialogDescription>
              The user must already have a Familiarise account. To invite a
              brand-new email, use the Invitations page.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="add-email">Email</Label>
              <Input
                id="add-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="alice@acme.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-role">Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id="add-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SELECTABLE_ROLES.map((r) => (
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
            <Button
              variant="outline"
              onClick={() => setShowInvite(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => addMutation.mutate()}
              disabled={addMutation.isPending || !email.includes("@")}
            >
              {addMutation.isPending ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
