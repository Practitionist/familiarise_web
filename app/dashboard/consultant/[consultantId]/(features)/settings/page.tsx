"use client";

import { useEffect, useState, use } from "react";
import { fetchConsultantData } from "../../utils";
import { TConsultantProfile } from "types/consultant";
import { SettingsTab } from "./SettingsTab";

export default function SettingsPage({
  params,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
}>) {
  const resolvedParams = use(params);
  const consultantId = resolvedParams.consultantId;

  const [consultant, setConsultant] = useState<TConsultantProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        setIsLoading(true);
        setError(null);

        const consultantData = await fetchConsultantData(consultantId);
        setConsultant(consultantData);
      } catch (err) {
        console.error("Error fetching consultant data:", err);
        setError(err instanceof Error ? err.message : "An error occurred");
      } finally {
        setIsLoading(false);
      }
    }

    fetchData();
  }, [consultantId]);

  if (error) {
    return (
      <div className="bg-white p-4 rounded-lg shadow-md">
        <p className="text-red-600">{error}</p>
      </div>
    );
  }

  if (isLoading || !consultant) {
    return (
      <div className="bg-white p-4 rounded-lg shadow-md">
        <p>Loading...</p>
      </div>
    );
  }

  return <SettingsTab consultant={consultant} />;
}
