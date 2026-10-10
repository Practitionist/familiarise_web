"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Download, FileSpreadsheet, ShieldCheck } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const SupportHealthPayloadSchema = z.object({
  days: z.number().optional(),
  resolved: z.number(),
  escalated: z.number(),
  deflectionRate: z.number().nullable(),
  recontactRate7d: z.number().nullable(),
});

const SupportHealthResponseSchema = z.object({
  data: SupportHealthPayloadSchema,
});

type SupportHealthPayload = z.infer<typeof SupportHealthPayloadSchema>;

const ComplianceReportCaseRowSchema = z.object({
  referenceNumber: z.string().nullable(),
  category: z.string().nullable(),
  status: z.string(),
  createdAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
});

const ComplianceReportPayloadSchema = z.object({
  year: z.number(),
  month: z.number(),
  received: z.number(),
  acknowledgedWithin24h: z.number(),
  disposedWithin15d: z.number(),
  appealed: z.number(),
  cases: z.array(ComplianceReportCaseRowSchema),
});

const ComplianceReportResponseSchema = z.object({
  data: ComplianceReportPayloadSchema,
});

type ComplianceReportPayload = z.infer<typeof ComplianceReportPayloadSchema>;

export function SupportHealthAndComplianceOverview({
  tree,
}: Readonly<{ tree: string }>) {
  const istNow = new Date(Date.now() + 330 * 60_000);
  const [selectedYear, setSelectedYear] = useState(istNow.getUTCFullYear());
  const [selectedMonth, setSelectedMonth] = useState(istNow.getUTCMonth() + 1);

  const isAdmin = tree === "admin";

  const healthQuery = useQuery<SupportHealthPayload>({
    queryKey: ["admin-support-health"],
    queryFn: async () => {
      const res = await fetch("/api/admin/support/health?days=30");
      if (!res.ok) throw new Error("Failed to fetch support health");
      return SupportHealthResponseSchema.parse(await res.json()).data;
    },
    enabled: isAdmin,
  });

  const complianceQuery = useQuery<ComplianceReportPayload>({
    queryKey: ["admin-support-compliance", selectedYear, selectedMonth],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/support/compliance-report?year=${selectedYear}&month=${selectedMonth}`,
      );
      if (!res.ok) throw new Error("Failed to fetch compliance report");
      return ComplianceReportResponseSchema.parse(await res.json()).data;
    },
    enabled: isAdmin,
  });

  if (!isAdmin) return null;

  const downloadCsv = () => {
    const report = complianceQuery.data;
    if (!report) return;
    const header = [
      "Reference",
      "Category",
      "Status",
      "Created (UTC)",
      "Acknowledged (UTC)",
      "Resolved (UTC)",
    ];
    const rows = report.cases.map((c) => [
      c.referenceNumber ?? "",
      c.category ?? "",
      c.status,
      c.createdAt,
      c.acknowledgedAt ?? "",
      c.resolvedAt ?? "",
    ]);
    const escapeCsvCell = (cell: string): string => {
      const safe = /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const csv = [header, ...rows]
      .map((line) => line.map(escapeCsvCell).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `familiarise-grievance-report-${selectedYear}-${String(selectedMonth).padStart(2, "0")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mb-4 grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Activity className="h-4 w-4 text-emerald-600" /> Self-Serve &amp;
            Deflection Health (30d)
          </CardTitle>
          <CardDescription className="text-xs">
            Deflection rate paired with 7-day re-contact guard so silent
            drop-offs surface alongside self-serve completions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {healthQuery.data ? (
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-md border border-border p-2.5">
                <p className="text-lg font-semibold">
                  {healthQuery.data.deflectionRate ?? 0}%
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Deflected ({healthQuery.data.resolved})
                </p>
              </div>
              <div className="rounded-md border border-border p-2.5">
                <p className="text-lg font-semibold">
                  {healthQuery.data.escalated}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Escalated to staff
                </p>
              </div>
              <div className="rounded-md border border-border p-2.5">
                <p className="text-lg font-semibold">
                  {healthQuery.data.recontactRate7d ?? 0}%
                </p>
                <p className="text-[11px] text-muted-foreground">
                  7-day re-contact
                </p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {healthQuery.isError
                ? "Unable to load support health metrics."
                : "Loading self-serve metrics…"}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <ShieldCheck className="h-4 w-4 text-blue-600" /> Monthly
                Grievance Redressal Summary
              </CardTitle>
              <CardDescription className="text-xs">
                IT Rules 2021 Rule 3(2) &amp; E-Commerce Rules compliance audit
                counts.
              </CardDescription>
            </div>
            <div className="flex items-center gap-1.5">
              <select
                aria-label="Compliance year"
                className="h-7 rounded border border-border bg-background px-2 text-xs"
                value={selectedYear}
                onChange={(e) => setSelectedYear(Number(e.target.value))}
              >
                {[istNow.getUTCFullYear() - 1, istNow.getUTCFullYear()].map(
                  (yr) => (
                    <option key={yr} value={yr}>
                      {yr}
                    </option>
                  ),
                )}
              </select>
              <select
                aria-label="Compliance month"
                className="h-7 rounded border border-border bg-background px-2 text-xs"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(Number(e.target.value))}
              >
                {Array.from({ length: 12 }, (_, idx) => idx + 1).map((m) => (
                  <option key={m} value={m}>
                    {String(m).padStart(2, "0")}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={!complianceQuery.data?.cases?.length}
                onClick={downloadCsv}
              >
                <Download className="mr-1 h-3.5 w-3.5" /> CSV
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {complianceQuery.data ? (
            <div className="grid grid-cols-4 gap-2 text-center">
              <div className="rounded-md border border-border p-2">
                <p className="text-base font-semibold">
                  {complianceQuery.data.received}
                </p>
                <p className="text-[11px] text-muted-foreground">Received</p>
              </div>
              <div className="rounded-md border border-border p-2">
                <p className="text-base font-semibold">
                  {complianceQuery.data.acknowledgedWithin24h}
                </p>
                <p className="text-[11px] text-muted-foreground">Ack ≤ 24h</p>
              </div>
              <div className="rounded-md border border-border p-2">
                <p className="text-base font-semibold">
                  {complianceQuery.data.disposedWithin15d}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Disposed ≤ 15d
                </p>
              </div>
              <div className="rounded-md border border-border p-2">
                <p className="text-base font-semibold flex items-center justify-center gap-1">
                  <FileSpreadsheet className="h-3.5 w-3.5 text-muted-foreground" />
                  {complianceQuery.data.appealed}
                </p>
                <p className="text-[11px] text-muted-foreground">Appeals</p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {complianceQuery.isError
                ? "Unable to load monthly grievance summary."
                : "Loading compliance report…"}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
