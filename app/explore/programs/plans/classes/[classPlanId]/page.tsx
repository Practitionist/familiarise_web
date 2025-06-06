"use client";

import { use, useEffect, useState } from "react";
import { redirect } from "next/navigation";
import { ClassDetails, type ClassPlanDetailsData } from "./components/ClassDetails";

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
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!classPlan) return null;

  return <ClassDetails plan={classPlan} />;
}
