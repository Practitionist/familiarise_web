import Link from "next/link";
import { Download, FileText, FileX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { formatFileSize } from "@/lib/documents/document-utils";
import type {
  BuyerFile,
  RemovedBuyerFile,
} from "@/lib/digital-products/buyer-files";

const SUPPORT_HREF = "/support";

const downloadHref = (productId: string, assetId: string) =>
  `/api/digital-products/${encodeURIComponent(productId)}/assets/${encodeURIComponent(assetId)}/download`;

const day = (at: Date) =>
  at.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  });

/** A buyer's downloadable files, then the ones the expert removed after they bought it. */
export function BuyerFileList({
  productId,
  files,
  removed,
  free,
}: Readonly<{
  productId: string;
  files: BuyerFile[];
  removed: RemovedBuyerFile[];
  /** A ₹0 claim has nothing to refund. */
  free: boolean;
}>) {
  return (
    <div className="space-y-2">
      <ul className="divide-y rounded-md border text-sm">
        {files.map((file) => (
          <li key={file.id} className="flex items-center gap-3 p-2.5">
            <FileText
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 break-words" title={file.name}>
                {file.name}
              </p>
              <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                <span>{formatFileSize(file.sizeBytes)}</span>
                {file.updatedAt && <span>· Updated {day(file.updatedAt)}</span>}
                {file.badge && (
                  <StatusBadge
                    size="sm"
                    tone="info"
                    label={file.badge === "new" ? "New" : "Updated"}
                  />
                )}
              </p>
            </div>
            <Button
              asChild
              size="sm"
              variant="outline"
              className="shrink-0 px-2.5 sm:px-3"
            >
              <a
                href={downloadHref(productId, file.id)}
                aria-label={`Download ${file.name}`}
              >
                <Download className="h-3.5 w-3.5 sm:mr-1.5" aria-hidden />
                <span className="hidden sm:inline">Download</span>
              </a>
            </Button>
          </li>
        ))}
      </ul>
      {removed.length > 0 && (
        <div className="space-y-1.5 rounded-md border border-dashed p-2.5 text-sm">
          <ul className="space-y-1">
            {removed.map((file) => (
              <li
                key={file.lineageId}
                className="flex items-start gap-3 text-muted-foreground"
              >
                <FileX className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span className="min-w-0 break-words">
                  <span className="line-through">{file.name}</span>
                  {" · "}Removed by the expert on{" "}
                  {file.removedAt.toLocaleDateString("en-IN", {
                    dateStyle: "medium",
                    timeZone: "Asia/Kolkata",
                  })}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            {free
              ? "Questions about a removed file? "
              : "Needed a removed file? You can ask about a refund through "}
            <Link
              href={SUPPORT_HREF}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {free ? "Contact support" : "support"}
            </Link>
            .
          </p>
        </div>
      )}
    </div>
  );
}
