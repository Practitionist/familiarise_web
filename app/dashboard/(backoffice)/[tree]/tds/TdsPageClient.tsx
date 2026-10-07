"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FileText,
  CheckCircle2,
  AlertTriangle,
  IndianRupee,
  Users,
  Calendar,
  Download,
  ExternalLink,
  Loader2,
} from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/PageScaffold";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { ScopedListTable } from "@/components/dashboard/ScopedListTable";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { formatCurrencyAmount as formatCurrencyFromMinorUnit } from "@/utils/formatting";

function StatCard({
  title,
  value,
  subtitle,
  loading,
}: Readonly<{
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: unknown;
  variant?: "default" | "success" | "warning" | "danger";
  loading?: boolean;
}>) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-7 w-24" />
        ) : (
          <>
            <div className="text-xl font-semibold tabular-nums">{value}</div>
            {subtitle && (
              <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface QuarterSummary {
  financialYear: string;
  quarter: number;
  totalConsultants: number;
  totalAmountCredited: number;
  totalTDSDeducted: number;
  totalRecords: number;
  unfiledRecords: number;
}

interface ConsultantBreakdown {
  deducteeKey?: string;
  consultantProfileId: string | null;
  organizationId?: string | null;
  userId: string | null;
  consultantName: string | null;
  consultantEmail: string | null;
  panLast4: string | null;
  panVerified: boolean;
  totalCredited: number;
  totalTDS: number;
  recordCount: number;
  allFiled: boolean;
}

const QUARTER_LABELS: Record<number, string> = {
  1: "Q1 (Apr–Jun)",
  2: "Q2 (Jul–Sep)",
  3: "Q3 (Oct–Dec)",
  4: "Q4 (Jan–Mar)",
};

function getCurrentFY(): string {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  if (month >= 4) {
    return `${year}-${String(year + 1).slice(2)}`;
  }
  return `${year - 1}-${String(year).slice(2)}`;
}

function getRecentFYs(): string[] {
  const current = getCurrentFY();
  const startYear = Number.parseInt(current.split("-")[0], 10);
  return [
    `${startYear}-${String(startYear + 1).slice(2)}`,
    `${startYear - 1}-${String(startYear).slice(2)}`,
    `${startYear - 2}-${String(startYear - 1).slice(2)}`,
  ];
}

function RecordFilingDialog({
  financialYear,
  quarter,
  open,
  onOpenChange,
}: Readonly<{
  financialYear: string;
  quarter: number | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}>) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filingDate, setFilingDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [ackNumber, setAckNumber] = useState("");
  const [reason, setReason] = useState("");
  const [reportedInForm26Q, setReportedInForm26Q] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const filingMutation = useMutation({
    mutationFn: async (payload: {
      financialYear: string;
      quarter: number;
      filingDate: string;
      ackNumber?: string;
      reportedInForm26Q: boolean;
      reason: string;
    }) => {
      const res = await fetch("/api/admin/tds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ??
            "Failed to record Form 26Q (Form 140) filing",
        );
      }
      return json as { message: string };
    },
    onSuccess: (data) => {
      toast({
        title: "Form 26Q (Form 140) Updated",
        description: data.message,
      });
      queryClient.invalidateQueries({ queryKey: ["admin-tds"] });
      queryClient.invalidateQueries({ queryKey: ["admin-tds-consultants"] });
      setAckNumber("");
      setReason("");
      setError(null);
      onOpenChange(false);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  if (!quarter) return null;

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="sm:max-w-md">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>
            Record Form 26Q (Form 140) Filing — FY {financialYear} Q{quarter}
          </ResponsiveModalTitle>
        </ResponsiveModalHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tds-filing-date">Filing Date *</Label>
              <Input
                id="tds-filing-date"
                type="date"
                value={filingDate}
                onChange={(e) => setFilingDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tds-ack-no">TRACES Token / Ack No.</Label>
              <Input
                id="tds-ack-no"
                value={ackNumber}
                onChange={(e) => setAckNumber(e.target.value)}
                placeholder="PRN / Ack number"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tds-reported-flag">
              Form 26Q (Form 140) Status
            </Label>
            <Select
              value={reportedInForm26Q ? "FILED" : "PENDING"}
              onValueChange={(v) => setReportedInForm26Q(v === "FILED")}
            >
              <SelectTrigger id="tds-reported-flag">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="FILED">
                  Reported in Form 26Q (Form 140) — Filed
                </SelectItem>
                <SelectItem value="PENDING">Pending filing</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tds-audit-reason">Audit reason *</Label>
            <Input
              id="tds-audit-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Filed quarterly return on TRACES"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <ResponsiveModalFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setError(null);
              if (reason.trim().length < 5) {
                setError("Audit reason must be at least 5 characters.");
                return;
              }
              filingMutation.mutate({
                financialYear,
                quarter,
                filingDate,
                ackNumber: ackNumber.trim() || undefined,
                reportedInForm26Q,
                reason: reason.trim(),
              });
            }}
            disabled={filingMutation.isPending}
          >
            {filingMutation.isPending ? (
              <>
                <Loader2 className="mr-1 h-4 w-4 animate-spin" /> Saving…
              </>
            ) : (
              "Save Filing Record"
            )}
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}

export default function AdminTDSPage() {
  const { basePath, can } = useBackofficeCapability();
  const canManage = can("tds.read") && basePath.startsWith("/dashboard/admin");
  const [selectedFY, setSelectedFY] = useState(getCurrentFY);
  const [searchQuery, setSearchQuery] = useState("");
  const [filingFilter, setFilingFilter] = useState<string>("ALL");
  const [filingQuarter, setFilingQuarter] = useState<number | null>(null);
  const recentFYs = getRecentFYs();

  const { data: quarterlyData, isLoading: loadingQuarters } = useQuery<{
    financialYear: string;
    quarters: QuarterSummary[];
  }>({
    queryKey: ["admin-tds", selectedFY],
    queryFn: async () => {
      const res = await fetch(`/api/admin/tds?fy=${selectedFY}`);
      if (!res.ok) throw new Error("Failed to fetch TDS summary");
      return res.json();
    },
  });

  const {
    data: consultantData,
    isLoading: loadingConsultants,
    isError: errorConsultants,
  } = useQuery<{
    financialYear: string;
    consultants: ConsultantBreakdown[];
  }>({
    queryKey: ["admin-tds-consultants", selectedFY],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/tds?fy=${selectedFY}&view=consultants`,
      );
      if (!res.ok) throw new Error("Failed to fetch consultant breakdown");
      return res.json();
    },
  });

  const quarters = quarterlyData?.quarters || [];
  const totalTDS = quarters.reduce((s, q) => s + q.totalTDSDeducted, 0);
  const totalCredited = quarters.reduce((s, q) => s + q.totalAmountCredited, 0);
  const totalUnfiled = quarters.reduce((s, q) => s + q.unfiledRecords, 0);
  const totalConsultants = new Set(
    (consultantData?.consultants || []).map(
      (c) => c.consultantProfileId ?? c.userId ?? "",
    ),
  ).size;

  const filteredConsultants = useMemo(() => {
    const all = consultantData?.consultants ?? [];
    return all.filter((c) => {
      if (filingFilter === "FILED" && !c.allFiled) return false;
      if (filingFilter === "PENDING" && c.allFiled) return false;
      if (!searchQuery.trim()) return true;
      const needle = searchQuery.trim().toLowerCase();
      return (
        (c.consultantName ?? "").toLowerCase().includes(needle) ||
        (c.consultantEmail ?? "").toLowerCase().includes(needle) ||
        (c.panLast4 ?? "").toLowerCase().includes(needle) ||
        (c.consultantProfileId ?? "").toLowerCase().includes(needle)
      );
    });
  }, [consultantData?.consultants, filingFilter, searchQuery]);

  const handleExportCsv = () => {
    const sanitizeCsvCell = (value: string) => {
      const isNumeric = /^[+-]?\d+(\.\d+)?$/.test(value.trim());
      const safe =
        !isNumeric && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const rows = [
      [
        "Financial Year",
        "Consultant Name",
        "Email",
        "User ID",
        "Masked PAN",
        "Total Credited (INR)",
        "TDS Deducted (INR)",
        "Deduction Count",
        "Form 26Q (Form 140) Status",
      ],
      ...filteredConsultants.map((c) => [
        selectedFY,
        c.consultantName ?? "Unnamed Expert",
        c.consultantEmail ?? "",
        c.userId ?? c.consultantProfileId ?? "",
        c.panLast4 ? `XXXXXX${c.panLast4}` : "Missing",
        (c.totalCredited / 100).toFixed(2),
        (c.totalTDS / 100).toFixed(2),
        String(c.recordCount),
        c.allFiled ? "Filed" : "Pending",
      ]),
    ];
    const csvContent = rows
      .map((r) => r.map((cell) => sanitizeCsvCell(String(cell))).join(","))
      .join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `tds-breakdown-${selectedFY}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <DashboardHeader
        title="TDS Management (Section 194O / 194J)"
        subtitle="Track tax deducted at source, Challan / BSR filings, Form 26Q (Form 140), and Form 16A (Form 131) compliance"
        actions={
          <div className="flex items-center gap-2">
            <Select value={selectedFY} onValueChange={setSelectedFY}>
              <SelectTrigger
                aria-label="Select financial year"
                className="h-9 w-[140px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {recentFYs.map((fy) => (
                  <SelectItem key={fy} value={fy}>
                    FY {fy}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              onClick={handleExportCsv}
              disabled={filteredConsultants.length === 0}
            >
              <Download className="mr-1.5 h-4 w-4" /> Export CSV
            </Button>
          </div>
        }
      />

      <DashboardContent>
        <DashboardGrid columns={4}>
          <StatCard
            title="Total TDS Deducted"
            value={formatCurrencyFromMinorUnit(totalTDS, "INR")}
            subtitle={`FY ${selectedFY}`}
            icon={IndianRupee}
            loading={loadingQuarters}
          />
          <StatCard
            title="Total Credited to Consultants"
            value={formatCurrencyFromMinorUnit(totalCredited, "INR")}
            subtitle={`FY ${selectedFY}`}
            icon={FileText}
            loading={loadingQuarters}
          />
          <StatCard
            title="Consultants with TDS"
            value={totalConsultants}
            subtitle="Exceeding threshold"
            icon={Users}
            loading={loadingConsultants}
          />
          <StatCard
            title="Unfiled Records"
            value={totalUnfiled}
            subtitle={totalUnfiled > 0 ? "Action needed" : "All filed"}
            icon={totalUnfiled > 0 ? AlertTriangle : CheckCircle2}
            variant={totalUnfiled > 0 ? "warning" : "success"}
            loading={loadingQuarters}
          />
        </DashboardGrid>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {loadingQuarters
            ? Array.from({ length: 4 }).map((_, i) => (
                <Card key={i}>
                  <CardHeader className="pb-2">
                    <Skeleton className="h-5 w-28" />
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <Skeleton className="h-8 w-24" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-8 w-full" />
                  </CardContent>
                </Card>
              ))
            : quarters.map((q) => (
                <Card key={q.quarter}>
                  <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="text-sm font-medium">
                      {QUARTER_LABELS[q.quarter]}
                    </CardTitle>
                    {q.totalRecords > 0 && (
                      <Badge
                        variant={q.unfiledRecords > 0 ? "secondary" : "default"}
                        className={
                          q.unfiledRecords === 0
                            ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
                            : ""
                        }
                      >
                        {q.unfiledRecords > 0
                          ? `${q.unfiledRecords} unfiled`
                          : "Filed"}
                      </Badge>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div>
                      <p className="text-2xl font-bold">
                        {formatCurrencyFromMinorUnit(q.totalTDSDeducted, "INR")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        on{" "}
                        {formatCurrencyFromMinorUnit(
                          q.totalAmountCredited,
                          "INR",
                        )}{" "}
                        credited ({q.totalConsultants} consultant
                        {q.totalConsultants !== 1 ? "s" : ""})
                      </p>
                    </div>
                    {canManage && q.totalRecords > 0 && (
                      <Button
                        size="sm"
                        variant={q.unfiledRecords > 0 ? "default" : "outline"}
                        className="w-full"
                        onClick={() => setFilingQuarter(q.quarter)}
                      >
                        <Calendar className="mr-1.5 h-3.5 w-3.5" />
                        {q.unfiledRecords > 0
                          ? "Record Challan / 26Q"
                          : "Update Filing Info"}
                      </Button>
                    )}
                    {q.totalRecords === 0 && (
                      <p className="text-xs text-muted-foreground italic">
                        No TDS deductions this quarter
                      </p>
                    )}
                  </CardContent>
                </Card>
              ))}
        </div>

        <ScopedListTable<ConsultantBreakdown>
          title={`Consultant Breakdown — FY ${selectedFY}`}
          description="Experts with statutory withholding in the selected financial year."
          isLoading={loadingConsultants}
          isError={errorConsultants}
          items={filteredConsultants}
          total={filteredConsultants.length}
          page={1}
          perPage={Math.max(25, filteredConsultants.length)}
          rowKey={(c) =>
            c.deducteeKey ??
            c.consultantProfileId ??
            c.userId ??
            String(c.totalCredited)
          }
          emptyMessage={`No TDS deductions recorded for FY ${selectedFY}.`}
          toolbar={
            <FilterBar
              search={{
                label: "Search experts",
                placeholder: "Search by expert name, email, or PAN last 4…",
                value: searchQuery,
                onChange: setSearchQuery,
              }}
              selects={[
                {
                  key: "filingStatus",
                  label: "Form 26Q (Form 140) status",
                  value: filingFilter,
                  options: [
                    { value: "ALL", label: "All filing statuses" },
                    { value: "FILED", label: "Filed" },
                    { value: "PENDING", label: "Pending" },
                  ],
                  onChange: setFilingFilter,
                },
              ]}
              canClear={Boolean(searchQuery) || filingFilter !== "ALL"}
              onClear={() => {
                setSearchQuery("");
                setFilingFilter("ALL");
              }}
            />
          }
          columns={[
            {
              header: "Expert",
              accessor: (c) => (
                <div className="min-w-0">
                  {c.userId ? (
                    <Link
                      href={`${basePath}/users/${c.userId}`}
                      className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
                    >
                      {c.consultantName || "Unnamed Expert"}
                      <ExternalLink className="h-3 w-3 text-muted-foreground" />
                    </Link>
                  ) : (
                    <span className="font-medium">
                      {c.consultantName || c.consultantProfileId || "—"}
                    </span>
                  )}
                  {c.consultantEmail && (
                    <p className="text-xs text-muted-foreground">
                      {c.consultantEmail}
                    </p>
                  )}
                </div>
              ),
            },
            {
              header: "PAN",
              accessor: (c) =>
                c.panLast4 ? (
                  <span className="font-mono text-xs">
                    XXXXXX{c.panLast4}{" "}
                    {c.panVerified && (
                      <Badge variant="outline" className="ml-1 text-[10px]">
                        Verified
                      </Badge>
                    )}
                  </span>
                ) : (
                  <Badge variant="secondary" className="text-xs">
                    No PAN (5% §397(2) / 194-O)
                  </Badge>
                ),
            },
            {
              header: "Total Credited",
              accessor: (c) => (
                <span className="tabular-nums">
                  {formatCurrencyFromMinorUnit(c.totalCredited, "INR")}
                </span>
              ),
            },
            {
              header: "TDS Deducted",
              accessor: (c) => (
                <span className="font-semibold tabular-nums">
                  {formatCurrencyFromMinorUnit(c.totalTDS, "INR")}
                </span>
              ),
            },
            {
              header: "Deductions",
              accessor: (c) => (
                <span className="tabular-nums">{c.recordCount}</span>
              ),
            },
            {
              header: "Form 26Q (Form 140)",
              accessor: (c) => (
                <Badge
                  variant={c.allFiled ? "default" : "secondary"}
                  className={
                    c.allFiled
                      ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
                      : ""
                  }
                >
                  {c.allFiled ? "Filed" : "Pending"}
                </Badge>
              ),
            },
          ]}
        />
      </DashboardContent>

      {canManage && (
        <RecordFilingDialog
          financialYear={selectedFY}
          quarter={filingQuarter}
          open={filingQuarter !== null}
          onOpenChange={(v) => !v && setFilingQuarter(null)}
        />
      )}
    </>
  );
}
