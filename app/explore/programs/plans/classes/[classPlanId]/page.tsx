"use client";

import { use, useEffect, useState } from "react";
import { redirect } from "next/navigation";
import { GraduationCap } from "lucide-react";
import {
  ClassDetails,
  type ClassPlanDetailsData,
} from "./components/ClassDetails";

export default function ClassDetailsPage({
  params,
}: Readonly<{
  params: Promise<{ classPlanId: string }>;
}>) {
  const [classPlan, setClassPlan] = useState<ClassPlanDetailsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const resolvedParams = use(params);
  const classPlanId = resolvedParams.classPlanId;

  useEffect(() => {
    const fetchClassPlanData = async () => {
      try {
        const response = await fetch(`/api/plans/classes/${classPlanId}`);
        if (!response.ok) throw new Error("Failed to fetch class plan data");
        const resJson = await response.json();
        setClassPlan(resJson.data);
      } catch (error) {
        console.error("Error fetching class plan data:", error);
        redirect("/explore/programs/classes");
      } finally {
        setIsLoading(false);
      }
    };

    fetchClassPlanData();
  }, [classPlanId]);

  if (isLoading) {
    return (
      <main className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="w-16 h-16 border-4 border-zinc-200 border-t-zinc-900 rounded-full animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center">
              <GraduationCap className="w-6 h-6 text-zinc-400" />
            </div>
          </div>
          <p className="text-zinc-500 text-sm">Loading class details...</p>
        </div>
      </main>
    );
  }

  if (!classPlan) return null;

  return <ClassDetails plan={classPlan} />;
}
