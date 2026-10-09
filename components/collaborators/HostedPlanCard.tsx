"use client";

/**
 * Host-perspective card: one of the current consultant's own plans that
 * has collaborators on it.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { useToast } from "@/hooks/use-toast";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { formatCurrencyAmount } from "@/utils/formatting";
import type { HostedPlanEntry } from "./types";
import { COLLABORATOR_STATUS_BADGE, formatRole } from "./format";
import { RevenueSplitBar } from "./RevenueSplitBar";
import {
  ClassEventList,
  ClassScheduleSummary,
  WebinarEventList,
  WebinarScheduleSummary,
} from "./ScheduleSummaries";

const WEBINAR_ROLES = [
  { value: "CO_HOST", label: "Co-Host", isPresenter: true },
  { value: "MODERATOR", label: "Moderator", isPresenter: false },
  { value: "GUEST_SPEAKER", label: "Guest Speaker", isPresenter: false },
  {
    value: "TECHNICAL_SUPPORT",
    label: "Technical Support",
    isPresenter: false,
  },
];

const CLASS_ROLES = [
  { value: "CO_INSTRUCTOR", label: "Co-Instructor", isPresenter: true },
  {
    value: "TEACHING_ASSISTANT",
    label: "Teaching Assistant",
    isPresenter: false,
  },
  { value: "GUEST_LECTURER", label: "Guest Lecturer", isPresenter: false },
  { value: "CONTENT_CREATOR", label: "Content Creator", isPresenter: false },
];

const PRESENTER_ROLES = new Set(["CO_HOST", "CO_INSTRUCTOR"]);

export function HostedPlanCard({
  plan,
  hostUser,
  hostLabel = "You",
  onRefresh,
}: {
  plan: HostedPlanEntry;
  hostUser?: { name: string | null; image: string | null };
  /** Whose share the host segment is — the viewer's unless an org reads it. */
  hostLabel?: string;
  onRefresh?: () => void;
}) {
  const [eventsExpanded, setEventsExpanded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState("");
  const [editSharePct, setEditSharePct] = useState(10);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { toast } = useToast();
  const router = useRouter();

  const planId = plan.webinarPlan?.id ?? plan.classPlan?.id;
  const roleOptions = plan.planType === "webinar" ? WEBINAR_ROLES : CLASS_ROLES;

  const activeCollabs = plan.collaborators.filter(
    (c) => c.status === "PENDING" || c.status === "ACCEPTED",
  );

  const totalCollabShare = Number(
    (
      activeCollabs.reduce((sum, c) => sum + c.revenueShareBps, 0) / 100
    ).toFixed(2),
  );
  const hostShare = Number((100 - totalCollabShare).toFixed(2));

  const pendingCollabs = plan.collaborators.filter(
    (c) => c.status === "PENDING",
  );
  const acceptedCollabs = plan.collaborators.filter(
    (c) => c.status === "ACCEPTED",
  );

  const hasExpandableDetails =
    (plan.planType === "webinar" &&
      plan.webinarPlan &&
      plan.webinarPlan.webinars.length > 1) ||
    (plan.planType === "class" &&
      plan.classPlan &&
      plan.classPlan.classes.length > 1);

  const planTypeLabel = plan.planType === "webinar" ? "Webinar" : "Class";

  const triggerRefresh = () => {
    if (onRefresh) {
      onRefresh();
    } else {
      router.refresh();
    }
  };

  const handleSaveEdit = async (collabId: string) => {
    if (!planId) return;
    setBusyId(collabId);
    try {
      const res = await fetch(
        `/api/collaborations/${plan.planType}/${planId}/${collabId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role: editRole,
            revenueSharePercentage: editSharePct,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to update collaborator");
      }
      setEditingId(null);
      toast({ title: "Collaborator updated" });
      triggerRefresh();
    } catch (error) {
      toast({
        title: "Failed to update collaborator",
        description:
          error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = async (collabId: string) => {
    if (!planId) return;
    setBusyId(collabId);
    try {
      const res = await fetch(
        `/api/collaborations/${plan.planType}/${planId}/${collabId}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to remove collaborator");
      }
      toast({ title: "Collaborator removed" });
      triggerRefresh();
    } catch (error) {
      toast({
        title: "Failed to remove collaborator",
        description:
          error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className="overflow-hidden border-zinc-200/80 shadow-sm transition-shadow hover:shadow-md">
      <div className="p-4 sm:p-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Badge className="rounded-md border-0 bg-zinc-900 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white hover:bg-zinc-900">
                Host
              </Badge>
              <Badge
                variant="secondary"
                className="rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-[10px] font-medium text-zinc-600"
              >
                {planTypeLabel}
              </Badge>
            </div>
            <p className="truncate text-[15px] font-semibold tracking-tight text-zinc-900">
              {plan.title}
            </p>
            {plan.price > 0 && (
              <p className="mt-0.5 text-sm text-zinc-500">
                {formatCurrencyAmount(plan.price, "INR")}
              </p>
            )}
          </div>
        </div>

        {/* Revenue split */}
        <div className="mt-3.5">
          <RevenueSplitBar
            avatar={hostUser}
            segments={[
              {
                key: "host",
                percent: hostShare,
                className: "bg-zinc-800",
              },
              {
                key: "collaborators",
                percent: totalCollabShare,
                className: "bg-teal-500/80",
              },
            ]}
            label={
              <>
                <span className="font-semibold text-zinc-800">
                  {hostLabel} {hostShare}%
                </span>
                <span className="text-zinc-400"> · </span>
                <span>Collaborators {totalCollabShare}%</span>
              </>
            }
          />
        </div>

        {/* Collaborators list */}
        <div className="mt-4">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-400">
            Collaborators ({plan.collaborators.length})
          </p>
          <div className="space-y-1.5">
            {[...acceptedCollabs, ...pendingCollabs].map((collab) => {
              const isEditing = editingId === collab.id;
              const isBusy = busyId === collab.id;
              const otherSharesPct =
                activeCollabs
                  .filter((c) => c.id !== collab.id)
                  .reduce((sum, c) => sum + c.revenueShareBps, 0) / 100;
              const maxAllowedShare = Math.max(
                1,
                Number((90 - otherSharesPct).toFixed(2)),
              );
              const otherHasPresenter = activeCollabs.some(
                (c) => c.id !== collab.id && PRESENTER_ROLES.has(c.role),
              );

              return (
                <div
                  key={collab.id}
                  className="rounded-xl border border-zinc-100 bg-white px-2.5 py-2"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Avatar className="h-8 w-8 ring-1 ring-zinc-100">
                        <AvatarImage
                          src={collab.consultantProfile.user.image ?? undefined}
                        />
                        <AvatarFallback className="bg-zinc-100 text-[11px] text-zinc-600">
                          {(collab.consultantProfile.user.name ?? "?").charAt(
                            0,
                          )}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-zinc-900">
                          {collab.consultantProfile.user.name ?? "Unknown"}
                        </p>
                        {!isEditing && (
                          <p className="truncate text-xs text-zinc-500">
                            {formatRole(collab.role)} ·{" "}
                            {collab.revenueShareBps / 100}% share
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      <StatusBadge
                        size="sm"
                        {...COLLABORATOR_STATUS_BADGE[collab.status]}
                      />
                      {planId && collab.status === "PENDING" && !isEditing && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Edit collaborator"
                          disabled={isBusy}
                          className="h-7 w-7 text-zinc-400 hover:text-zinc-700"
                          onClick={() => {
                            setEditingId(collab.id);
                            setEditRole(collab.role);
                            setEditSharePct(collab.revenueShareBps / 100);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {planId && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label="Remove collaborator"
                              disabled={isBusy}
                              className="h-7 w-7 text-zinc-400 hover:text-red-600"
                            >
                              {isBusy && !isEditing ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                Remove collaborator?
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                Removing{" "}
                                {collab.consultantProfile.user.name ??
                                  "this collaborator"}{" "}
                                revokes their live call and channel access and
                                releases their {collab.revenueShareBps / 100}%
                                share on future sales. Already settled earnings
                                remain intact.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel disabled={isBusy}>
                                Cancel
                              </AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleRemove(collab.id)}
                                disabled={isBusy}
                                className="bg-red-600 text-white hover:bg-red-700"
                              >
                                Remove
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>
                  </div>

                  {isEditing && (
                    <div className="mt-2.5 flex flex-wrap items-end gap-2 border-t border-zinc-100 pt-2.5">
                      <div className="min-w-[140px] flex-1">
                        <label className="text-[11px] font-medium text-zinc-600">
                          Role
                        </label>
                        <Select value={editRole} onValueChange={setEditRole}>
                          <SelectTrigger className="mt-1 h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {roleOptions.map((opt) => (
                              <SelectItem
                                key={opt.value}
                                value={opt.value}
                                disabled={opt.isPresenter && otherHasPresenter}
                              >
                                {opt.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="w-24">
                        <label className="text-[11px] font-medium text-zinc-600">
                          Share (%)
                        </label>
                        <Input
                          type="number"
                          min={1}
                          max={maxAllowedShare}
                          value={editSharePct}
                          onChange={(e) =>
                            setEditSharePct(Number(e.target.value))
                          }
                          className="mt-1 h-8 text-xs"
                        />
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          size="sm"
                          className="h-8 px-2.5"
                          disabled={
                            isBusy ||
                            !editRole ||
                            editSharePct < 1 ||
                            editSharePct > maxAllowedShare
                          }
                          onClick={() => handleSaveEdit(collab.id)}
                        >
                          {isBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Check className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-8 px-2"
                          disabled={isBusy}
                          onClick={() => setEditingId(null)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Schedule summary */}
        <div className="mt-4 rounded-xl border border-zinc-100 bg-zinc-50/50 px-3 py-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-400">
            Schedule
          </p>
          {plan.planType === "webinar" && plan.webinarPlan ? (
            <WebinarScheduleSummary plan={plan.webinarPlan} />
          ) : plan.planType === "class" && plan.classPlan ? (
            <ClassScheduleSummary plan={plan.classPlan} />
          ) : (
            <p className="text-xs italic text-zinc-400">
              No schedule data available
            </p>
          )}

          {hasExpandableDetails && (
            <div className="mt-2.5 border-t border-zinc-100 pt-2.5">
              <button
                type="button"
                onClick={() => setEventsExpanded((prev) => !prev)}
                className="flex items-center gap-1 text-[11px] text-zinc-500 transition-colors hover:text-zinc-800"
              >
                {eventsExpanded ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
                {eventsExpanded ? "Hide" : "Show"} all events
              </button>
              {eventsExpanded && (
                <div className="mt-2">
                  {plan.planType === "webinar" && plan.webinarPlan ? (
                    <WebinarEventList plan={plan.webinarPlan} />
                  ) : plan.planType === "class" && plan.classPlan ? (
                    <ClassEventList plan={plan.classPlan} />
                  ) : null}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
