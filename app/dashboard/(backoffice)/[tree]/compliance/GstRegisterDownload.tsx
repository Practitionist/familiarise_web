"use client";

import { useState } from "react";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The monthly GST outward-supplies register — the GSTR-1 working file.
 *
 * The export job writes one CSV per IST calendar month into the private
 * finance bucket; the admin route exchanges that month for a short-lived
 * signed URL. The month is picked here rather than derived in the browser, so
 * the file that comes back is the one the job wrote for that IST month and not
 * for whichever month the operator's own clock is in.
 */
export function GstRegisterDownload() {
  const [period, setPeriod] = useState("");
  const href = period
    ? `/api/admin/compliance/gst-register?period=${encodeURIComponent(period)}`
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          GST outward-supplies register
        </CardTitle>
        <CardDescription>
          Every tax invoice and credit note the platform issued in one IST
          calendar month, in the shape a chartered accountant files GSTR-1 from.
          The export job runs on the second of the following month, so a month
          becomes downloadable only once that job has produced it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="gst-register-period">Period (IST month)</Label>
          <Input
            id="gst-register-period"
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="w-56"
            aria-describedby="gst-register-period-hint"
          />
          <p
            id="gst-register-period-hint"
            className="text-xs text-muted-foreground"
          >
            The month the supplies belong to — October 2026 is 2026-10.
          </p>
        </div>
        {href ? (
          <Button asChild size="sm">
            <a href={href}>
              <Download className="mr-1.5 h-4 w-4" /> Download register
            </a>
          </Button>
        ) : (
          <Button size="sm" disabled>
            <Download className="mr-1.5 h-4 w-4" /> Download register
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
