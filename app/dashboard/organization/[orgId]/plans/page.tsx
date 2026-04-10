"use client";

import { use, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Pencil } from "lucide-react";

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
  CardDescription,
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCurrencyAmount } from "@/utils/formatting";

interface OrgPlan {
  id: string;
  planType: "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR" | "CLASS" | "TRIAL";
  title: string;
  description: string | null;
  price: number;
  priceCurrency: string;
  isActive: boolean;
}

const PLAN_TYPES = [
  { value: "CONSULTATION", label: "Consultation" },
  { value: "SUBSCRIPTION", label: "Subscription" },
  { value: "WEBINAR", label: "Webinar" },
  { value: "CLASS", label: "Class" },
];

async function fetchPlans(orgId: string): Promise<{ plans: OrgPlan[] }> {
  const res = await fetch(`/api/organizations/${orgId}/plans`);
  if (!res.ok) throw new Error("Failed to load plans");
  return res.json();
}

interface CreatePlanPayload {
  planType: string;
  title: string;
  description: string;
  price: number;
}

async function createPlan(orgId: string, payload: CreatePlanPayload) {
  const res = await fetch(`/api/organizations/${orgId}/plans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Failed to create plan");
  return body;
}

async function updatePlan(
  orgId: string,
  planId: string,
  payload: { title?: string; description?: string | null; price?: number; isActive?: boolean },
) {
  const res = await fetch(`/api/organizations/${orgId}/plans/${planId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Failed to update plan");
  return body;
}

async function deletePlan(orgId: string, planId: string) {
  const res = await fetch(`/api/organizations/${orgId}/plans/${planId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to delete plan");
  }
}

export default function OrgPlansPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["org-plans", orgId],
    queryFn: () => fetchPlans(orgId),
  });

  const [showCreate, setShowCreate] = useState(false);
  const [planType, setPlanType] = useState("CONSULTATION");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priceMajor, setPriceMajor] = useState("0");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      createPlan(orgId, {
        planType,
        title: title.trim(),
        description: description.trim(),
        price: Math.round(parseFloat(priceMajor || "0") * 100),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-plans", orgId] });
      setShowCreate(false);
      setTitle("");
      setDescription("");
      setPriceMajor("0");
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (planId: string) => deletePlan(orgId, planId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["org-plans", orgId] }),
  });

  // Edit plan state
  const [editPlan, setEditPlan] = useState<OrgPlan | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editPriceMajor, setEditPriceMajor] = useState("0");
  const [editError, setEditError] = useState<string | null>(null);

  const openEditPlan = (p: OrgPlan) => {
    setEditPlan(p);
    setEditTitle(p.title);
    setEditDesc(p.description ?? "");
    setEditPriceMajor(String(p.price / 100));
    setEditError(null);
  };

  const editPlanMutation = useMutation({
    mutationFn: () =>
      updatePlan(orgId, editPlan!.id, {
        title: editTitle.trim(),
        description: editDesc.trim() || null,
        price: Math.round(parseFloat(editPriceMajor || "0") * 100),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-plans", orgId] });
      setEditPlan(null);
    },
    onError: (err: Error) => setEditError(err.message),
  });

  return (
    <>
      <DashboardHeader
        title="Plans"
        subtitle="Catalog plans owned by this organization"
        actions={
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1" /> New plan
          </Button>
        }
      />
      <DashboardContent>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {isLoading ? "Loading…" : `${data?.plans.length ?? 0} plans`}
            </CardTitle>
            <CardDescription>
              Plans created here can be assigned to learners and bookings.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data?.plans.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.title}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{p.planType}</Badge>
                      </TableCell>
                      <TableCell>
                        {formatCurrencyAmount(p.price, p.priceCurrency)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={p.isActive ? "default" : "outline"}
                        >
                          {p.isActive ? "Active" : "Archived"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Edit plan"
                            onClick={() => openEditPlan(p)}
                          >
                            <Pencil className="h-4 w-4 text-zinc-500" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Archive plan"
                            onClick={() => deleteMutation.mutate(p.id)}
                            disabled={!p.isActive || deleteMutation.isPending}
                          >
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {data && data.plans.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center text-sm text-zinc-500 py-6"
                      >
                        No plans yet.
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
            <DialogTitle>New plan</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="plan-type">Type</Label>
              <Select value={planType} onValueChange={setPlanType}>
                <SelectTrigger id="plan-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLAN_TYPES.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="plan-title">Title</Label>
              <Input
                id="plan-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="System design 1:1"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="plan-desc">Description</Label>
              <Input
                id="plan-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="plan-price">Price (₹)</Label>
              <Input
                id="plan-price"
                type="number"
                min="0"
                step="0.01"
                value={priceMajor}
                onChange={(e) => setPriceMajor(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || title.length < 2}
            >
              {createMutation.isPending ? "Creating…" : "Create plan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit plan dialog */}
      <Dialog open={!!editPlan} onOpenChange={(open) => !open && setEditPlan(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit plan</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-title">Title</Label>
              <Input
                id="edit-title"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-desc">Description</Label>
              <Input
                id="edit-desc"
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-price">Price (INR)</Label>
              <Input
                id="edit-price"
                type="number"
                min="0"
                step="0.01"
                value={editPriceMajor}
                onChange={(e) => setEditPriceMajor(e.target.value)}
              />
            </div>
            {editError && <p className="text-sm text-red-600">{editError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditPlan(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => editPlanMutation.mutate()}
              disabled={editPlanMutation.isPending || editTitle.length < 2}
            >
              {editPlanMutation.isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
