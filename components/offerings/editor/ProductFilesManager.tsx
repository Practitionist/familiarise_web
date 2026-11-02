"use client";

import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Download,
  FileText,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { z } from "zod";
import type { DigitalProductCategory } from "@prisma/client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { useToast } from "@/hooks/use-toast";
import { putFileWithProgress } from "@/lib/documents/direct-upload";
import { formatFileSize } from "@/lib/documents/document-utils";
import { errorMessageFromBody } from "@/lib/fetch-helpers";
import {
  allowedExtensionsFor,
  categoryFileRule,
  DIGITAL_PRODUCT_MAX_FILE_BYTES,
  DIGITAL_PRODUCT_MAX_FILES,
  digitalProductAcceptAttr,
  mimeFitsCategory,
  resolveDigitalProductMime,
} from "@/lib/digital-products/constants";
import { describeRejectReason } from "@/lib/digital-products/reject-reasons";
import type { Tone } from "@/lib/ui/tone";
import type { OwnedProductAsset } from "./load-offering";

const presignSchema = z.object({
  data: z.object({
    assetId: z.string(),
    uploadUrl: z.string().url(),
    headers: z.record(z.string()),
  }),
});
const commitSchema = z.object({
  data: z.object({
    status: z.enum(["PENDING", "VERIFIED", "REJECTED", "SUPERSEDED"]),
    reason: z.string().nullable(),
  }),
});
type CommitResult = z.infer<typeof commitSchema>["data"];

const STATUS_CHIP: Record<
  OwnedProductAsset["status"],
  { label: string; tone: Tone }
> = {
  PENDING: { label: "Not verified", tone: "caution" },
  VERIFIED: { label: "Verified", tone: "success" },
  REJECTED: { label: "Rejected", tone: "critical" },
  SUPERSEDED: { label: "Replaced", tone: "neutral" },
};

const assetPath = (productId: string, rest = "") =>
  `/api/digital-products/${encodeURIComponent(productId)}/assets${rest}`;

async function call(url: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: init.body ? { "Content-Type": "application/json" } : undefined,
    });
  } catch {
    throw new Error("Network error. Check your connection and try again.");
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(errorMessageFromBody(body, "Something went wrong"));
  }
  return body;
}

/** Verify an uploaded file; R2 can lag a PUT briefly, so one retry. */
async function commit(
  productId: string,
  assetId: string,
): Promise<CommitResult> {
  const url = assetPath(productId, `/${encodeURIComponent(assetId)}/commit`);
  try {
    return commitSchema.parse(await call(url, { method: "POST" })).data;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return commitSchema.parse(await call(url, { method: "POST" })).data;
  }
}

/** Presign (new file or a new version), PUT the bytes to R2, then verify. */
async function uploadOne(params: {
  productId: string;
  file: File;
  category: DigitalProductCategory;
  replacing?: string;
  onProgress: (percent: number) => void;
}): Promise<CommitResult> {
  const { productId, file, category, replacing } = params;
  const mimeType = resolveDigitalProductMime(file.name, file.type);
  if (!mimeType) {
    throw new Error(
      `${file.name}: this file type isn't supported. Allowed: ${allowedExtensionsFor(category).join(", ")}.`,
    );
  }
  if (!mimeFitsCategory(mimeType, category)) {
    throw new Error(`${file.name}: ${categoryFileRule(category)}`);
  }
  if (file.size === 0 || file.size > DIGITAL_PRODUCT_MAX_FILE_BYTES) {
    throw new Error(`${file.name}: files must be between 1 byte and 250 MB`);
  }
  const presign = presignSchema.parse(
    await call(
      assetPath(
        productId,
        replacing ? `/${encodeURIComponent(replacing)}/replace` : "/upload-url",
      ),
      {
        method: "POST",
        body: JSON.stringify({
          fileName: file.name,
          mimeType,
          sizeBytes: file.size,
        }),
      },
    ),
  ).data;
  try {
    await putFileWithProgress(
      presign.uploadUrl,
      file,
      presign.headers["Content-Type"] ?? mimeType,
      params.onProgress,
      presign.headers,
    );
  } catch {
    throw new Error(`${file.name}: the upload didn't finish. Try again.`);
  }
  return commit(productId, presign.assetId);
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  });

/** A file's history in words: when it was added, or when it was last replaced. */
function historyText(asset: OwnedProductAsset): string | null {
  if (!asset.verifiedAt) return null;
  return `${asset.version > 1 ? "Updated" : "Added"} ${day(asset.verifiedAt)}`;
}

/** One toast for a batch: the reason for a single rejection, otherwise a count that points to the list. */
export function verdictToast(names: string[], results: CommitResult[]) {
  const rejected = results
    .map((r, i) => ({ ...r, name: names[i] }))
    .filter((r) => r.status === "REJECTED");
  const verified = results.filter((r) => r.status === "VERIFIED").length;
  if (rejected.length === 0) {
    return { title: verified === 1 ? "File verified" : "Files verified" };
  }
  if (results.length === 1) {
    return {
      title: `${rejected[0].name} was rejected`,
      description: describeRejectReason(rejected[0].reason).message,
      variant: "destructive" as const,
    };
  }
  return {
    title: `${rejected.length} ${rejected.length === 1 ? "file was" : "files were"} rejected`,
    description: `${verified > 0 ? `${verified} verified. ` : ""}See Rejected uploads in Files for why.`,
    variant: "destructive" as const,
  };
}

/** What removing a file costs: who loses it, and the published product's one-file floor. */
function removeImpact(
  asset: OwnedProductAsset | null,
  buyerCount: number,
  isPublished: boolean,
): string {
  const loss =
    asset?.status === "VERIFIED" && buyerCount > 0
      ? `${buyerCount} ${buyerCount === 1 ? "buyer" : "buyers"} will lose access to this file. They'll see it listed as removed by you.`
      : "Buyers will no longer see this file.";
  return isPublished
    ? `${loss} A published product keeps at least one file.`
    : loss;
}

/** The friendly sentence, with the code and its detail kept small for support. */
function RejectReason({ stored }: Readonly<{ stored: string | null }>) {
  const { message, code, detail } = describeRejectReason(stored);
  return (
    <div className="space-y-0.5 text-xs">
      <p className="text-destructive">{message}</p>
      {code && (
        <p className="break-all font-mono text-[11px] text-muted-foreground">
          {detail ? `${code} · ${detail}` : code}
        </p>
      )}
    </div>
  );
}

/**
 * Upload, verify, replace, reorder and remove a digital product's files.
 * Rows come from the owner's product read; every change refetches it.
 */
export function ProductFilesManager({
  productId,
  category,
  isPublished,
  buyerCount,
  assets,
  onChanged,
}: Readonly<{
  productId: string;
  category: DigitalProductCategory;
  isPublished: boolean;
  /** Buyers holding access now; they lose a removed file. */
  buyerCount: number;
  assets: OwnedProductAsset[];
  onChanged: () => Promise<unknown>;
}>) {
  const { toast } = useToast();
  const addInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    name: string;
    percent: number;
  } | null>(null);
  const [deleting, setDeleting] = useState<OwnedProductAsset | null>(null);

  // Only PENDING and VERIFIED files hold an order slot and count toward the caps.
  const rows = assets
    .filter((a) => a.status === "PENDING" || a.status === "VERIFIED")
    .sort((a, b) => a.order - b.order);
  const liveCount = rows.length;
  const rejected = assets.filter((a) => a.status === "REJECTED");
  const accept = digitalProductAcceptAttr(category);

  const fail = (error: unknown) => {
    toast({
      title: "Couldn't update the files",
      description: error instanceof Error ? error.message : "Please try again.",
      variant: "destructive",
    });
    void onChanged();
  };
  const reportVerdicts = (names: string[], results: CommitResult[]) =>
    toast(verdictToast(names, results));

  const add = useMutation({
    mutationFn: async (files: File[]) => {
      if (liveCount + files.length > DIGITAL_PRODUCT_MAX_FILES) {
        throw new Error(
          `A product holds at most ${DIGITAL_PRODUCT_MAX_FILES} files; this one has ${liveCount}.`,
        );
      }
      const results: CommitResult[] = [];
      for (const file of files) {
        setProgress({ name: file.name, percent: 0 });
        results.push(
          await uploadOne({
            productId,
            file,
            category,
            onProgress: (percent) => setProgress({ name: file.name, percent }),
          }),
        );
        // Each verdict shows at once, so a rejected file never sits as unverified.
        void onChanged();
      }
      return { names: files.map((f) => f.name), results };
    },
    onSuccess: ({ names, results }) => {
      reportVerdicts(names, results);
      void onChanged();
    },
    onError: fail,
    onSettled: () => setProgress(null),
  });
  const replace = useMutation({
    mutationFn: async (args: { assetId: string; file: File }) => {
      setProgress({ name: args.file.name, percent: 0 });
      const result = await uploadOne({
        productId,
        file: args.file,
        category,
        replacing: args.assetId,
        onProgress: (percent) => setProgress({ name: args.file.name, percent }),
      });
      return { names: [args.file.name], results: [result] };
    },
    onSuccess: ({ names, results }) => {
      reportVerdicts(names, results);
      void onChanged();
    },
    onError: fail,
    onSettled: () => {
      setReplacing(null);
      setProgress(null);
    },
  });
  const verify = useMutation({
    mutationFn: async (asset: OwnedProductAsset) => ({
      names: [asset.originalName],
      results: [await commit(productId, asset.id)],
    }),
    onSuccess: ({ names, results }) => {
      reportVerdicts(names, results);
      void onChanged();
    },
    onError: fail,
  });
  const reorder = useMutation({
    mutationFn: (assetIds: string[]) =>
      call(assetPath(productId, "/reorder"), {
        method: "POST",
        body: JSON.stringify({ assetIds }),
      }),
    onSuccess: () => void onChanged(),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (assetId: string) =>
      call(assetPath(productId, `/${encodeURIComponent(assetId)}`), {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast({ title: "File removed" });
      void onChanged();
    },
    onError: fail,
  });

  const busy =
    add.isPending ||
    replace.isPending ||
    verify.isPending ||
    reorder.isPending ||
    remove.isPending;
  const move = (index: number, delta: -1 | 1) => {
    const ids = rows.map((a) => a.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorder.mutate(ids);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Up to {DIGITAL_PRODUCT_MAX_FILES} files, 250 MB each and 1 GB in
          total. Each file is checked before buyers can download it.
        </p>
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => addInput.current?.click()}
        >
          <Upload className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          {add.isPending ? "Uploading…" : "Add files"}
        </Button>
        <input
          ref={addInput}
          type="file"
          multiple
          accept={accept}
          className="sr-only"
          aria-label="Add files"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length > 0) add.mutate(files);
          }}
        />
        <input
          ref={replaceInput}
          type="file"
          accept={accept}
          className="sr-only"
          aria-label="Choose a replacement file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file && replacing) replace.mutate({ assetId: replacing, file });
          }}
        />
      </div>

      {progress && (
        <div role="status" className="space-y-1 text-xs text-muted-foreground">
          <p className="truncate">
            Uploading {progress.name} · {progress.percent}%
          </p>
          <div className="h-1.5 overflow-hidden rounded bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No files yet. Add at least one file before publishing.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {rows.map((asset, index) => {
            // A PENDING row during an upload batch is being checked now.
            const checking = asset.status === "PENDING" && busy;
            const chip = checking
              ? { label: "Checking…", tone: "info" as const }
              : STATUS_CHIP[asset.status];
            const history = historyText(asset);
            return (
              <li key={asset.id} className="flex items-start gap-3 p-3 text-sm">
                <FileText
                  className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <p
                    className="line-clamp-2 break-words font-medium"
                    title={asset.originalName}
                  >
                    {asset.originalName}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <StatusBadge label={chip.label} tone={chip.tone} />
                    <span>{formatFileSize(asset.sizeBytes)}</span>
                    {history && <span>{history}</span>}
                  </div>
                  {asset.displayName !== asset.originalName && (
                    <p className="text-xs text-muted-foreground">
                      Buyers see it as {asset.displayName}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-0.5">
                  {asset.status === "VERIFIED" && (
                    <Button
                      asChild
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                    >
                      <a
                        href={assetPath(
                          productId,
                          `/${encodeURIComponent(asset.id)}/download`,
                        )}
                        aria-label={`Download ${asset.originalName}`}
                      >
                        <Download className="h-3.5 w-3.5" aria-hidden />
                      </a>
                    </Button>
                  )}
                  {asset.status === "PENDING" && !checking && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      disabled={busy}
                      onClick={() => verify.mutate(asset)}
                    >
                      Verify
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    aria-label={`Move ${asset.originalName} up`}
                    disabled={busy || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    aria-label={`Move ${asset.originalName} down`}
                    disabled={busy || index === rows.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                  {asset.status === "VERIFIED" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      aria-label={`Replace ${asset.originalName}`}
                      disabled={busy}
                      onClick={() => {
                        setReplacing(asset.id);
                        replaceInput.current?.click();
                      }}
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${replacing === asset.id && replace.isPending ? "animate-spin" : ""}`}
                        aria-hidden
                      />
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 text-destructive"
                    aria-label={`Remove ${asset.originalName}`}
                    disabled={busy}
                    onClick={() => setDeleting(asset)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {rejected.length > 0 && (
        <section aria-labelledby="rejected-files" className="space-y-2">
          <h3 id="rejected-files" className="text-sm font-medium">
            Rejected uploads
          </h3>
          <p className="text-xs text-muted-foreground">
            Buyers never see these and they don&apos;t count toward the file
            limit. Fix the file and upload it again.
          </p>
          <ul className="divide-y rounded-md border border-destructive/30">
            {rejected.map((asset) => (
              <li key={asset.id} className="flex items-start gap-3 p-3 text-sm">
                <FileText
                  className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <p
                    className="line-clamp-2 break-words font-medium"
                    title={asset.originalName}
                  >
                    {asset.originalName}
                  </p>
                  {asset.version > 1 && (
                    <p className="text-xs text-muted-foreground">
                      Replacement for {asset.displayName}
                    </p>
                  )}
                  <RejectReason stored={asset.rejectReason} />
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 px-2"
                  aria-label={`Dismiss ${asset.originalName}`}
                  disabled={busy}
                  onClick={() => remove.mutate(asset.id)}
                >
                  Dismiss
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {deleting?.originalName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removeImpact(deleting, buyerCount, isPublished)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting) remove.mutate(deleting.id);
                setDeleting(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
