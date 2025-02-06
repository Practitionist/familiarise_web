"use client";

import { use, useEffect, useState } from "react";
import { redirect } from "next/navigation";
import { ClassDetails } from "./components/ClassDetails";
import type { TClass } from "@/types/appointment";

export default function ClassDetailsPage({
  params,
}: Readonly<{
  params: Promise<{ classId: string }>;
}>) {
  const [classData, setClassData] = useState<TClass | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const resolvedParams = use(params);
  const classId = resolvedParams.classId;

  useEffect(() => {
    const fetchClassData = async () => {
      try {
        const response = await fetch(`/api/events/classes/${classId}`);
        if (!response.ok) throw new Error("Failed to fetch class data");
        const resJson = await response.json();
        setClassData(resJson.data);
      } catch (error) {
        console.error("Error fetching class data:", error);
        redirect("/explore/programs/classes");
      } finally {
        setIsLoading(false);
      }
    };

    fetchClassData();
  }, [classId]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!classData) return null;

  return <ClassDetails classData={classData} />;
}
