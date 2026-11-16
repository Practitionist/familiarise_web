"use client";

import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Copy,
  Check,
  Loader2,
  Shield,
} from "lucide-react";
import { useMaintenanceState } from "@/providers/MaintenanceProvider";
import { useToast } from "@/hooks/use-toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MaintenanceBookingRemediation } from "@/components/dashboard/MaintenanceBookingRemediation";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { OperatorTime } from "@/lib/time/operator-time";
import { Label } from "@/components/ui/label";

const phaseSchema = z.enum(["OFF", "DEGRADED", "OFFLINE"]);
const stateSchema = z.object({
  phase: phaseSchema,
  reason: z.string().nullable(),
  estimatedEnd: z.string().nullable(),
  bypassSecret: z.string().nullable(),
  bypassCookieToken: z.string().nullable().optional(),
});
const responseSchema = z.object({
  state: stateSchema,
  bypassCookieToken: z.string().nullable().optional(),
  history: z.array(
    z.object({
      id: z.string(),
      phase: phaseSchema,
      reason: z.string().nullable(),
      startedAt: z.string().nullable(),
      endedAt: z.string().nullable(),
      estimatedEnd: z.string().nullable(),
      startedBy: z.string().nullable(),
      endedBy: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
type MaintenanceState = z.infer<typeof stateSchema>;
type MaintenanceWindow = z.infer<typeof responseSchema>["history"][number];

function toLocalDatetime(iso: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    // Format as YYYY-MM-DDTHH:MM for datetime-local input
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "";
  }
}

function toIsoDatetime(localDatetime: string): string | undefined {
  if (!localDatetime) return undefined;
  const parsed = new Date(localDatetime);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

export default function MaintenanceControls() {
  const { refresh: refreshBanner } = useMaintenanceState();
  const { toast } = useToast();

  const [state, setState] = useState<MaintenanceState | null>(null);
  const [history, setHistory] = useState<MaintenanceWindow[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [bypassSecret, setBypassSecret] = useState<string | null>(null);
  const [bypassCookieToken, setBypassCookieToken] = useState<string | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  // Form fields
  const [reason, setReason] = useState("");
  const [estimatedEnd, setEstimatedEnd] = useState("");

  // Track if active fields have been edited (for save button)
  const [hasEdits, setHasEdits] = useState(false);

  // Pre-flight check
  interface PreflightData {
    activeCalls: number;
    pendingPayments: number;
    upcomingAppointments: number;
    pendingPayouts: number;
    openDisputes: number;
    recommendation: "SAFE" | "CAUTION" | "RISKY";
    warnings: string[];
    checkedAt: string;
  }
  const [preflight, setPreflight] = useState<PreflightData | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/maintenance");
      if (!res.ok) throw new Error("Maintenance state is unavailable");
      const raw: unknown = await res.json();
      const data = responseSchema.parse(raw);
      setState(data.state);
      setHistory(data.history);

      // Pre-fill form when active
      if (data.state?.phase && data.state.phase !== "OFF") {
        setReason(data.state.reason || "");
        setEstimatedEnd(toLocalDatetime(data.state.estimatedEnd));
        if (data.state.bypassSecret) {
          setBypassSecret(data.state.bypassSecret);
        }
        const cookieTok =
          data.state.bypassCookieToken ?? data.bypassCookieToken ?? null;
        if (cookieTok) {
          setBypassCookieToken(cookieTok);
        }
      }
    } catch (error) {
      setState(null);
      setHistory([]);
      // API call to /api/admin/maintenance failed — network error or server 5xx
      console.error("Failed to fetch maintenance state:", error);
      toast({
        title: "Something went wrong",
        description:
          "Unable to load the current status. Please refresh the page or try again later.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchState();
  }, [fetchState]);

  const startMaintenance = async (phase: "DEGRADED" | "OFFLINE") => {
    setActionLoading(true);
    try {
      const estimatedEndIso = toIsoDatetime(estimatedEnd);
      if (estimatedEnd && !estimatedEndIso) {
        toast({
          title: "Invalid estimated end",
          description: "Please provide a valid date/time.",
          variant: "destructive",
        });
        return;
      }

      const res = await fetch("/api/admin/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase,
          reason,
          estimatedEnd: estimatedEndIso,
        }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast({
          title: "Failed to start maintenance",
          description: data?.error || "Request failed. Please try again.",
          variant: "destructive",
        });
        return;
      }

      setBypassSecret(data?.bypassSecret ?? null);
      setBypassCookieToken(data?.bypassCookieToken ?? null);
      setHasEdits(false);

      if (Array.isArray(data?.setupErrors) && data.setupErrors.length > 0) {
        toast({
          title: "Maintenance started with warnings",
          description: data.setupErrors[0],
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Maintenance request failed",
        description: "Refresh the current status, then retry the action.",
        variant: "destructive",
      });
    } finally {
      await Promise.allSettled([fetchState(), refreshBanner()]);
      setActionLoading(false);
    }
  };

  const updateMaintenance = async (overrides?: {
    phase?: "DEGRADED" | "OFFLINE";
  }) => {
    setActionLoading(true);
    try {
      const estimatedEndIso = toIsoDatetime(estimatedEnd);
      if (estimatedEnd && !estimatedEndIso) {
        toast({
          title: "Invalid estimated end",
          description: "Please provide a valid date/time.",
          variant: "destructive",
        });
        return;
      }

      const body: Record<string, string | undefined> = {
        reason,
        estimatedEnd: estimatedEndIso,
      };
      if (overrides?.phase) body.phase = overrides.phase;

      const res = await fetch("/api/admin/maintenance", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast({
          title: "Failed to update maintenance",
          description: data?.error || "Request failed. Please try again.",
          variant: "destructive",
        });
        return;
      }

      setHasEdits(false);

      if (Array.isArray(data?.setupErrors) && data.setupErrors.length > 0) {
        toast({
          title: "Maintenance updated with warnings",
          description: data.setupErrors[0],
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Maintenance request failed",
        description: "Refresh the current status, then retry the action.",
        variant: "destructive",
      });
    } finally {
      await Promise.allSettled([fetchState(), refreshBanner()]);
      setActionLoading(false);
    }
  };

  const endMaintenance = async () => {
    setActionLoading(true);
    try {
      const res = await fetch("/api/admin/maintenance", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast({
          title: "Failed to end maintenance",
          description: data?.error || "Request failed. Please try again.",
          variant: "destructive",
        });
        return;
      }

      setBypassSecret(null);
      setBypassCookieToken(null);
      setReason("");
      setEstimatedEnd("");
      setHasEdits(false);
    } catch {
      toast({
        title: "Maintenance request failed",
        description: "Refresh the current status, then retry the action.",
        variant: "destructive",
      });
    } finally {
      await Promise.allSettled([fetchState(), refreshBanner()]);
      setActionLoading(false);
    }
  };

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const runPreflight = async () => {
    setPreflightLoading(true);
    try {
      const res = await fetch("/api/admin/maintenance/preflight");
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast({
          title: "Pre-flight check failed",
          description: data?.error || "Unable to run pre-flight checks.",
          variant: "destructive",
        });
        return;
      }

      setPreflight(data);
    } catch {
      toast({ title: "Pre-flight check failed", variant: "destructive" });
    } finally {
      setPreflightLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/70" />
      </div>
    );
  }

  if (!state)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Maintenance status unavailable</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p role="alert">
            The current state could not be loaded. Refresh before changing
            maintenance.
          </p>
          <Button variant="outline" onClick={() => void fetchState()}>
            Refresh status
          </Button>
        </CardContent>
      </Card>
    );

  const isActive = state?.phase && state.phase !== "OFF";

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Current Status */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Current Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <StatusIndicator phase={state?.phase || "OFF"} />
            <div>
              <p className="font-medium text-foreground">
                {state?.phase === "OFF" && "All systems operational"}
                {state?.phase === "DEGRADED" && "Degraded mode active"}
                {state?.phase === "OFFLINE" && "Offline — site unreachable"}
              </p>
              {isActive && state?.reason && (
                <p className="text-sm text-muted-foreground mt-0.5">
                  {state.reason}
                </p>
              )}
              {isActive && state?.estimatedEnd && (
                <p className="text-sm text-muted-foreground mt-0.5">
                  ETA: <OperatorTime value={state.estimatedEnd} />
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Pre-flight Check (only when not in active maintenance) */}
      {!isActive && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Pre-flight Check</CardTitle>
                <CardDescription>
                  Verify system readiness before activating maintenance.
                </CardDescription>
              </div>
              <Button
                onClick={runPreflight}
                disabled={preflightLoading}
                variant="outline"
                size="sm"
              >
                {preflightLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Shield className="mr-2 h-4 w-4" />
                )}
                Run Check
              </Button>
            </div>
          </CardHeader>
          {preflight && (
            <CardContent className="space-y-3">
              <div className="flex items-center gap-3">
                {preflight.recommendation === "SAFE" && (
                  <Badge className="bg-green-100 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-900">
                    SAFE
                  </Badge>
                )}
                {preflight.recommendation === "CAUTION" && (
                  <Badge className="bg-yellow-100 text-yellow-700 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-400 dark:border-yellow-900">
                    CAUTION
                  </Badge>
                )}
                {preflight.recommendation === "RISKY" && (
                  <Badge className="bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900">
                    RISKY
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground/70">
                  Checked{" "}
                  <OperatorTime value={preflight.checkedAt} kind="time" />
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <PreflightStat
                  label="Active Calls"
                  value={preflight.activeCalls}
                  warn={preflight.activeCalls > 0}
                />
                <PreflightStat
                  label="Pending Payments"
                  value={preflight.pendingPayments}
                  warn={preflight.pendingPayments > 0}
                />
                <PreflightStat
                  label="Upcoming (4h)"
                  value={preflight.upcomingAppointments}
                  warn={preflight.upcomingAppointments > 0}
                />
                <PreflightStat
                  label="Pending Payouts"
                  value={preflight.pendingPayouts}
                  warn={preflight.pendingPayouts > 0}
                />
                <PreflightStat
                  label="Open Disputes"
                  value={preflight.openDisputes}
                  warn={preflight.openDisputes > 0}
                />
              </div>
              {preflight.warnings.length > 0 && (
                <ul className="text-sm text-muted-foreground space-y-1">
                  {preflight.warnings.map((w, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <AlertTriangle className="h-4 w-4 text-yellow-500 dark:text-yellow-400 shrink-0 mt-0.5" />
                      {w}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          )}
        </Card>
      )}

      {/* Controls */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Controls</CardTitle>
          <CardDescription>
            {isActive
              ? "Update the active maintenance window or end it."
              : "Start a maintenance window. Users will see a banner (degraded) or a full maintenance page (offline)."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Reason + ETA fields (shown in both states) */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="reason">
                Reason{" "}
                <span className="text-muted-foreground/70 font-normal">
                  (shown in banner)
                </span>
              </Label>
              <Input
                id="reason"
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (isActive) setHasEdits(true);
                }}
                placeholder="Database migration, deployment..."
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="eta">
                Estimated End (does not reopen the site)
              </Label>
              <Input
                id="eta"
                type="datetime-local"
                value={estimatedEnd}
                onChange={(e) => {
                  setEstimatedEnd(e.target.value);
                  if (isActive) setHasEdits(true);
                }}
              />
            </div>
          </div>

          {/* Action buttons */}
          {!isActive ? (
            <div className="flex flex-wrap gap-3 pt-2">
              <Button
                onClick={() => startMaintenance("DEGRADED")}
                disabled={actionLoading || reason.trim().length < 5}
                className="bg-yellow-500 hover:bg-yellow-600 text-white dark:bg-yellow-600 dark:hover:bg-yellow-700"
              >
                {actionLoading && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Start Degraded Mode
              </Button>
              {history[0]?.phase === "OFF" && (
                <Button
                  variant="outline"
                  onClick={endMaintenance}
                  disabled={actionLoading || reason.trim().length < 5}
                >
                  Retry Recovery
                </Button>
              )}
              {/* #1527 Q10 — taking the whole site down is typed-confirmed. */}
              <ConfirmDialog
                trigger={
                  <Button
                    disabled={actionLoading || reason.trim().length < 5}
                    variant="destructive"
                  >
                    {actionLoading && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    Start Offline Mode
                  </Button>
                }
                title="Take the site offline?"
                description="Every visitor sees the maintenance page and all system jobs stop until you end maintenance."
                confirmLabel="Go offline"
                tone="destructive"
                requireTyped="OFFLINE"
                onConfirm={() => startMaintenance("OFFLINE")}
              />
            </div>
          ) : (
            <div className="flex flex-wrap gap-3 pt-2">
              {hasEdits && (
                <Button
                  onClick={() => updateMaintenance()}
                  disabled={actionLoading || reason.trim().length < 5}
                >
                  {actionLoading && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Save Changes
                </Button>
              )}
              {state?.phase === "DEGRADED" && (
                <ConfirmDialog
                  trigger={
                    <Button
                      disabled={actionLoading || reason.trim().length < 5}
                      variant="destructive"
                    >
                      Escalate to Offline
                    </Button>
                  }
                  title="Escalate to offline?"
                  description="Every visitor sees the maintenance page and all system jobs stop until you end maintenance."
                  confirmLabel="Go offline"
                  tone="destructive"
                  requireTyped="OFFLINE"
                  onConfirm={() => updateMaintenance({ phase: "OFFLINE" })}
                />
              )}
              {state?.phase === "OFFLINE" && (
                <Button
                  variant="outline"
                  onClick={() => updateMaintenance({ phase: "OFFLINE" })}
                  disabled={actionLoading || reason.trim().length < 5}
                >
                  Retry Offline Setup
                </Button>
              )}
              {state?.phase === "OFFLINE" && (
                <Button
                  onClick={() => updateMaintenance({ phase: "DEGRADED" })}
                  disabled={actionLoading || reason.trim().length < 5}
                  className="bg-yellow-500 hover:bg-yellow-600 text-white dark:bg-yellow-600 dark:hover:bg-yellow-700"
                >
                  Downgrade to Degraded
                </Button>
              )}
              <Button
                onClick={endMaintenance}
                disabled={actionLoading || reason.trim().length < 5}
                variant="outline"
                className="text-green-700 border-green-300 hover:bg-green-50 dark:text-green-400 dark:border-green-900 dark:hover:bg-green-950/40"
              >
                End Maintenance
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {history[0] && (
        <MaintenanceBookingRemediation
          key={history[0].id}
          windowId={history[0].id}
        />
      )}

      {/* Bypass Secret */}
      {bypassSecret && (
        <Card className="border-border bg-muted/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-foreground">
              Bypass Access
            </CardTitle>
            <CardDescription>
              Use this token to bypass maintenance. Add as a request header or
              browser cookie.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md bg-muted px-3 py-2 text-sm text-foreground font-mono break-all">
                {bypassSecret}
              </code>
              <Button
                variant="outline"
                size="icon"
                className="shrink-0"
                onClick={() => copyToClipboard(bypassSecret)}
              >
                {copied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <div className="text-xs text-muted-foreground space-y-1">
              <p>
                Header:{" "}
                <code className="bg-muted px-1 rounded">
                  x-maintenance-bypass: {bypassSecret}
                </code>
              </p>
              <p>
                Cookie:{" "}
                <code className="bg-muted px-1 rounded break-all">
                  {bypassCookieToken
                    ? `maintenance_bypass=${bypassCookieToken}`
                    : "Signed cookie unavailable; refresh status."}
                </code>
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* History */}
      {history.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">History</CardTitle>
            <CardDescription>Last 20 maintenance windows</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="pb-2 pr-4 font-medium text-muted-foreground">
                      Phase
                    </th>
                    <th className="pb-2 pr-4 font-medium text-muted-foreground">
                      Reason
                    </th>
                    <th className="pb-2 pr-4 font-medium text-muted-foreground">
                      Started
                    </th>
                    <th className="pb-2 pr-4 font-medium text-muted-foreground">
                      Ended
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((w) => (
                    <tr
                      key={w.id}
                      className="border-b border-border last:border-0"
                    >
                      <td className="py-2.5 pr-4">
                        <PhaseBadge phase={w.phase} />
                      </td>
                      <td className="py-2.5 pr-4 text-muted-foreground max-w-[200px] truncate">
                        {w.reason || "—"}
                      </td>
                      <td className="py-2.5 pr-4 text-muted-foreground whitespace-nowrap">
                        <OperatorTime value={w.startedAt} />
                      </td>
                      <td className="py-2.5 pr-4 text-muted-foreground whitespace-nowrap">
                        <OperatorTime value={w.endedAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatusIndicator({ phase }: { phase: string }) {
  if (phase === "DEGRADED") {
    return (
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-yellow-100 dark:bg-yellow-950/40">
        <AlertTriangle className="h-6 w-6 text-yellow-600 dark:text-yellow-400" />
      </div>
    );
  }
  if (phase === "OFFLINE") {
    return (
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-950/40">
        <XCircle className="h-6 w-6 text-red-600 dark:text-red-400" />
      </div>
    );
  }
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-950/40">
      <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-400" />
    </div>
  );
}

function PreflightStat({
  label,
  value,
  warn,
}: {
  label: string;
  value: number;
  warn: boolean;
}) {
  return (
    <div className="rounded-md border border-border px-3 py-2 text-center">
      <p
        className={`text-lg font-semibold ${warn ? "text-yellow-600 dark:text-yellow-400" : "text-foreground"}`}
      >
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function PhaseBadge({ phase }: { phase: string }) {
  const variants: Record<string, string> = {
    OFF: "bg-green-100 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-900",
    DEGRADED:
      "bg-yellow-100 text-yellow-700 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-400 dark:border-yellow-900",
    OFFLINE:
      "bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900",
  };

  return (
    <Badge variant="outline" className={variants[phase] || variants.OFF}>
      {phase}
    </Badge>
  );
}
