"use client";

import { useEffect, useState, use } from "react";
import { fetchDocuments } from "../../utils";
import { type IDocument } from "../../types";
import { DocumentsTab } from "./DocumentsTab";

export default function DocumentsPage({
  params,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
}>) {
  const resolvedParams = use(params);
  const consultantId = resolvedParams.consultantId;

  const [documents, setDocuments] = useState<IDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        setIsLoading(true);
        setError(null);

        const documentsData = await fetchDocuments(consultantId);
        setDocuments(documentsData);
      } catch (err) {
        console.error("Error fetching documents:", err);
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

  if (isLoading) {
    return (
      <div className="bg-white p-4 rounded-lg shadow-md">
        <p>Loading...</p>
      </div>
    );
  }

  return <DocumentsTab documents={documents} />;
}
