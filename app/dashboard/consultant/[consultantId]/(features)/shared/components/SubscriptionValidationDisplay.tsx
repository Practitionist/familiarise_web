"use client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  AlertTriangle,
  CheckCircle2,
  Calendar,
  Clock,
  XCircle,
  Info,
} from "lucide-react";

interface WeeklyCallInfo {
  weekStart: Date;
  weekEnd: Date;
  existingCalls: number;
  maxCalls: number;
  canScheduleMore: boolean;
  availableSlots: number;
}

interface SubscriptionValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  weeklyInfo: WeeklyCallInfo[];
  totalCallsScheduled: number;
  maxTotalCalls: number;
  subscriptionPeriod: {
    start: Date;
    end: Date;
  };
}

interface SubscriptionValidationDisplayProps {
  validation: SubscriptionValidationResult | null;
  subscriptionType: string;
  isValidating: boolean;
  className?: string;
}

export function SubscriptionValidationDisplay({
  validation,
  subscriptionType,
  isValidating,
  className = "",
}: Readonly<SubscriptionValidationDisplayProps>) {
  if (isValidating) {
    return (
      <Card className={`border-blue-200 ${className}`}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-blue-700">
            <Clock className="h-4 w-4 animate-spin" />
            Validating Subscription...
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="h-2 bg-blue-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 animate-pulse"
                style={{ width: "60%" }}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              Checking availability and subscription limits...
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!validation) {
    return null;
  }

  const getSubscriptionLimits = () => {
    switch (subscriptionType) {
      case "Basic":
        return "1 call per week for 1 month (4-5 calls total)";
      case "Extended":
        return "2 calls per week for 2 months (16-18 calls total)";
      case "Comprehensive":
        return "3 calls per week for 6 months (72-78 calls total)";
      default:
        return `${validation.maxTotalCalls} calls total`;
    }
  };

  const getWeekStatus = (week: WeeklyCallInfo) => {
    if (week.existingCalls === 0) return "available";
    if (week.canScheduleMore) return "partial";
    return "full";
  };

  const getWeekStatusColor = (status: string) => {
    switch (status) {
      case "available":
        return "bg-green-100 text-green-800 border-green-200";
      case "partial":
        return "bg-yellow-100 text-yellow-800 border-yellow-200";
      case "full":
        return "bg-red-100 text-red-800 border-red-200";
      default:
        return "bg-gray-100 text-gray-800 border-gray-200";
    }
  };

  const getWeekStatusIcon = (status: string) => {
    switch (status) {
      case "available":
        return <CheckCircle2 className="h-3 w-3" />;
      case "partial":
        return <AlertTriangle className="h-3 w-3" />;
      case "full":
        return <XCircle className="h-3 w-3" />;
      default:
        return <Info className="h-3 w-3" />;
    }
  };

  const formatWeekRange = (week: WeeklyCallInfo) => {
    const start = week.weekStart.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    const end = week.weekEnd.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    return `${start} - ${end}`;
  };

  const overallProgress =
    validation.maxTotalCalls > 0
      ? (validation.totalCallsScheduled / validation.maxTotalCalls) * 100
      : 0;

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Overall Status */}
      <Card
        className={`border-2 ${validation.isValid ? "border-green-200" : "border-red-200"}`}
      >
        <CardHeader className="pb-3">
          <CardTitle
            className={`flex items-center gap-2 ${
              validation.isValid ? "text-green-700" : "text-red-700"
            }`}
          >
            {validation.isValid ? (
              <CheckCircle2 className="h-5 w-5" />
            ) : (
              <XCircle className="h-5 w-5" />
            )}
            {subscriptionType} Subscription Status
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Subscription Limits
              </p>
              <p className="text-sm">{getSubscriptionLimits()}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Period
              </p>
              <p className="text-sm">
                {validation.subscriptionPeriod.start.toLocaleDateString()} -{" "}
                {validation.subscriptionPeriod.end.toLocaleDateString()}
              </p>
            </div>
          </div>

          <div>
            <div className="flex justify-between items-center mb-2">
              <p className="text-sm font-medium">Overall Progress</p>
              <p className="text-sm text-muted-foreground">
                {validation.totalCallsScheduled} / {validation.maxTotalCalls}{" "}
                calls
              </p>
            </div>
            <Progress value={overallProgress} className="h-2" />
          </div>
        </CardContent>
      </Card>

      {/* Errors */}
      {validation.errors.length > 0 && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertTitle>Validation Errors</AlertTitle>
          <AlertDescription>
            <ul className="list-disc list-inside space-y-1 mt-2">
              {validation.errors.map((error) => (
                <li key={error} className="text-sm">
                  {error}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* Warnings */}
      {validation.warnings.length > 0 && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Important Notes</AlertTitle>
          <AlertDescription>
            <ul className="list-disc list-inside space-y-1 mt-2">
              {validation.warnings.map((warning) => (
                <li key={warning} className="text-sm">
                  {warning}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* Weekly Breakdown */}
      {validation.weeklyInfo.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Weekly Schedule Overview
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3">
              {validation.weeklyInfo.map((week, index) => {
                const status = getWeekStatus(week);
                const statusColor = getWeekStatusColor(status);
                const StatusIcon = () => getWeekStatusIcon(status);

                return (
                  <div
                    key={`${week.weekStart.toISOString()}-${index}`}
                    className="flex items-center justify-between p-3 border rounded-lg"
                  >
                    <div className="flex items-center gap-3">
                      <Badge
                        className={`${statusColor} flex items-center gap-1`}
                      >
                        <StatusIcon />
                        {status === "available" && "Available"}
                        {status === "partial" && "Partial"}
                        {status === "full" && "Full"}
                      </Badge>
                      <div>
                        <p className="font-medium text-sm">
                          Week {index + 1}: {formatWeekRange(week)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {week.existingCalls} / {week.maxCalls} calls scheduled
                        </p>
                      </div>
                    </div>

                    <div className="text-right">
                      {week.canScheduleMore ? (
                        <p className="text-sm text-green-600 font-medium">
                          {week.availableSlots} slot
                          {week.availableSlots !== 1 ? "s" : ""} available
                        </p>
                      ) : (
                        <p className="text-sm text-red-600 font-medium">
                          Fully booked
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Helpful Tips */}
      <Card className="border-blue-200 bg-blue-50">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-blue-700">
            <Info className="h-4 w-4" />
            Subscription Guidelines
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-blue-800">
          <p>
            • You can only schedule one call per week for Basic subscriptions
          </p>
          <p>• All calls must be within your subscription period</p>
          <p>
            • If a week already has the maximum calls, choose a different week
          </p>
          <p>• You can remove existing calls to reschedule if needed</p>
          {validation.isValid &&
            validation.weeklyInfo.some((w) => w.canScheduleMore) && (
              <p className="font-medium">
                ✓ You have available slots in{" "}
                {validation.weeklyInfo.filter((w) => w.canScheduleMore).length}{" "}
                weeks
              </p>
            )}
        </CardContent>
      </Card>
    </div>
  );
}
