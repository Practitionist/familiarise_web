import { fetchDocuments } from "../../utils/fetchHelpers";
import { type IDocument } from "../../types";
import { DocumentsTab } from "./DocumentsTab";

export default async function DocumentsPage({
  params,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
}>) {
  const resolvedParams = await params;
  const consultantId = resolvedParams.consultantId;

  let documents: IDocument[] = [];
  let error: string | null = null;

  try {
    documents = await fetchDocuments(consultantId);
  } catch (err) {
    console.error("Error fetching documents:", err);
    error =
      err instanceof Error
        ? err.message
        : "An error occurred while fetching documents.";
  }

  if (error) {
    return (
      <div className="bg-white p-4 rounded-lg shadow-md">
        <p className="text-red-600">Error loading documents: {error}</p>
      </div>
    );
  }

  return <DocumentsTab documents={documents} />;
}
