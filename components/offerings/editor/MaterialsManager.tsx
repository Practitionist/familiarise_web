"use client";

import { useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  FileText,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { z } from "zod";

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
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { postJson } from "@/lib/documents/direct-upload";
import { formatFileSize } from "@/lib/documents/document-utils";
import {
  FileActionError,
  friendlyErrorFromResponse,
  friendlyFileError,
} from "@/lib/documents/file-errors";
import {
  FILE_ACCEPT_ATTR,
  FILE_POLICY_HINT,
} from "@/lib/documents/file-policy";
import { materialKeys } from "@/lib/documents/query-keys";
import { getMaterialViewerUrl } from "@/lib/documents/urls";
import {
  addPlanMaterial,
  planMaterialsPath,
  replacePlanMaterial,
  type MaterialPlanKind,
} from "@/lib/plans/material-client";

const MaterialRowSchema = z.object({
  id: z.string(),
  originalName: z.string(),
  fileSize: z.number(),
  mimeType: z.string(),
  description: z.string().nullable(),
  order: z.number(),
});
export type ManagedMaterial = z.infer<typeof MaterialRowSchema>;

const OrgChangeSchema = z.object({
  action: z.enum(["added", "updated", "removed"]),
  materialId: z.string().nullable(),
  fileName: z.string().nullable(),
  orgName: z.string(),
  actorName: z.string().nullable(),
  at: z.string(),
});
export type OrgMaterialChange = z.infer<typeof OrgChangeSchema>;

const MaterialsResponseSchema = z.object({
  data: z.array(MaterialRowSchema),
  orgChanges: z.array(OrgChangeSchema).optional(),
});

async function send(url: string, init: RequestInit): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new FileActionError(friendlyFileError("NETWORK"));
  }
  if (!res.ok) throw new FileActionError(await friendlyErrorFromResponse(res));
}

function typeLabel(mimeType: string, name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()?.toUpperCase() : null;
  if (ext && ext.length <= 5) return ext;
  return mimeType.split("/").pop()?.toUpperCase() ?? "File";
}

/**
 * Add, rename, describe, reorder, replace and delete a plan's materials. Used
 * by the offering editor and by an organisation's Catalog › Materials.
 */
export function MaterialsManager({
  kind,
  planId,
  annotate,
  footer,
  onChanged,
}: Readonly<{
  kind: MaterialPlanKind;
  planId: string;
  /** An extra line per material, from the organisation's change trail. */
  annotate?: (materialId: string, changes: OrgMaterialChange[]) => ReactNode;
  /** Shown under the list, e.g. files the organisation removed. */
  footer?: (changes: OrgMaterialChange[], liveIds: Set<string>) => ReactNode;
  onChanged?: () => void;
}>) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const addInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    description: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<ManagedMaterial | null>(null);
  const key = materialKeys.offering(kind, planId);

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: key,
    queryFn: async () => {
      const res = await fetch(planMaterialsPath(kind, planId));
      if (!res.ok) {
        throw new FileActionError(await friendlyErrorFromResponse(res));
      }
      const parsed = MaterialsResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new FileActionError(friendlyFileError("SERVER_ERROR"));
      }
      return parsed.data;
    },
  });

  const done = (title: string) => {
    toast({ title });
    void queryClient.invalidateQueries({ queryKey: key });
    onChanged?.();
  };
  const fail = (error: unknown) => {
    const copy =
      error instanceof FileActionError
        ? { title: error.title, description: error.message }
        : friendlyFileError("SERVER_ERROR");
    toast({ ...copy, variant: "destructive" });
    void queryClient.invalidateQueries({ queryKey: key });
  };

  const add = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        await addPlanMaterial({ kind, planId, file });
      }
    },
    onSuccess: () => done("Files added"),
    onError: fail,
  });
  const replace = useMutation({
    mutationFn: (args: { materialId: string; file: File }) =>
      replacePlanMaterial({ kind, planId, ...args }),
    onSuccess: () => done("File replaced"),
    onError: fail,
    onSettled: () => setReplacing(null),
  });
  const update = useMutation({
    mutationFn: (args: { id: string; name: string; description: string }) =>
      send(`/api/plans/materials/${encodeURIComponent(args.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originalName: args.name.trim(),
          description: args.description.trim() || null,
        }),
      }),
    onSuccess: () => {
      setEditing(null);
      done("Saved");
    },
    onError: fail,
  });
  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) =>
      postJson(
        `${planMaterialsPath(kind, planId)}/order`,
        { orderedIds },
        "PUT",
      ).then(() => undefined),
    onSuccess: () => done("Order saved"),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      send(`/api/plans/materials/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: () => done("File deleted"),
    onError: fail,
  });

  if (isPending) {
    return <p className="text-sm text-muted-foreground">Loading materials…</p>;
  }
  if (isError) {
    return (
      <div className="space-y-1 text-sm text-muted-foreground">
        <p>Couldn&apos;t load the materials for this offering.</p>
        <Button size="sm" variant="outline" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const rows = data.data;
  const changes = data.orgChanges ?? [];
  const move = (index: number, delta: -1 | 1) => {
    const ids = rows.map((m) => m.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorder.mutate(ids);
  };
  const busy =
    add.isPending ||
    replace.isPending ||
    update.isPending ||
    reorder.isPending ||
    remove.isPending;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{FILE_POLICY_HINT}</p>
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
          accept={FILE_ACCEPT_ATTR}
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
          accept={FILE_ACCEPT_ATTR}
          className="sr-only"
          aria-label="Choose a replacement file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file && replacing)
              replace.mutate({ materialId: replacing, file });
          }}
        />
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No materials are attached to this offering yet.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {rows.map((m, index) => (
            <li key={m.id} className="space-y-2 p-3 text-sm">
              {editing?.id === m.id ? (
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (editing.name.trim()) update.mutate(editing);
                  }}
                >
                  <Input
                    aria-label="File name"
                    value={editing.name}
                    maxLength={200}
                    onChange={(e) =>
                      setEditing({ ...editing, name: e.target.value })
                    }
                  />
                  <Input
                    aria-label="Description"
                    placeholder="Description (optional)"
                    value={editing.description}
                    maxLength={500}
                    onChange={(e) =>
                      setEditing({ ...editing, description: e.target.value })
                    }
                  />
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={busy}>
                      Save
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="flex items-start gap-3">
                  <FileText
                    className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{m.originalName}</p>
                    <p className="text-xs text-muted-foreground">
                      {typeLabel(m.mimeType, m.originalName)} ·{" "}
                      {formatFileSize(m.fileSize)}
                    </p>
                    {m.description && (
                      <p className="break-words text-xs text-muted-foreground">
                        {m.description}
                      </p>
                    )}
                    {annotate?.(m.id, changes)}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-0.5">
                    <Button
                      asChild
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                    >
                      <a
                        href={getMaterialViewerUrl(m.id)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open
                        <ExternalLink className="ml-1 h-3 w-3" aria-hidden />
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      aria-label={`Move ${m.originalName} up`}
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
                      aria-label={`Move ${m.originalName} down`}
                      disabled={busy || index === rows.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      aria-label={`Rename ${m.originalName}`}
                      disabled={busy}
                      onClick={() =>
                        setEditing({
                          id: m.id,
                          name: m.originalName,
                          description: m.description ?? "",
                        })
                      }
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      aria-label={`Replace ${m.originalName}`}
                      disabled={busy}
                      onClick={() => {
                        setReplacing(m.id);
                        replaceInput.current?.click();
                      }}
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${replacing === m.id && replace.isPending ? "animate-spin" : ""}`}
                        aria-hidden
                      />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-destructive"
                      aria-label={`Delete ${m.originalName}`}
                      disabled={busy}
                      onClick={() => setDeleting(m)}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {footer?.(changes, new Set(rows.map((m) => m.id)))}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleting?.originalName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Buyers of this offering will no longer see this file.
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
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
