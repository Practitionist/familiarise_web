"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface PayoutsResponse {
  payouts?: Array<{
    id: string;
    amount: number;
    currency: string;
    status: string;
    periodStart: string;
    periodEnd: string;
  }>;
  error?: string;
  flag?: string;
}

async function fetchPayouts(orgId: string): Promise<PayoutsResponse> {
  const res = await fetch(`/api/organizations/${orgId}/payouts`);
  if (res.status === 501) return res.json();
  if (!res.ok) throw new Error("Failed to load payouts");
  return res.json();
}

export default function OrgPayoutsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const { data } = useQuery({
    queryKey: ["org-payouts", orgId],
    queryFn: () => fetchPayouts(orgId),
  });

  const isGated = !!data?.flag;

  return (
    <>
      <DashboardHeader
        title="Payouts"
        subtitle="Settlement history for the organization"
      />
      <DashboardContent>
        {isGated ? (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Lock className="h-5 w-5 text-zinc-500" />
                <CardTitle>Provider tier required</CardTitle>
              </div>
              <CardDescription>
                Payouts are available once your organization joins the
                Provider tier. Contact us to enable it.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-10 text-center text-sm text-zinc-500">
              No payouts yet.
            </CardContent>
          </Card>
        )}
      </DashboardContent>
    </>
  );
}
