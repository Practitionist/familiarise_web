"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import * as Sentry from "@sentry/nextjs";
import { AlertTriangle, Trash2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { errorMessageFromBody } from "@/lib/fetch-helpers";
import { isExpectedRefusal } from "@/lib/errors/client-refusal";
import { toast } from "@/components/ui/use-toast";
import {
  commitPlanImage,
  type StagedPlanImage,
} from "@/components/plans/PlanImageUploader";
import { OfferingEditor } from "./OfferingEditor";
import { DIGITAL_PRODUCT_MANIFEST } from "./manifests";
import {
  DIGITAL_PRODUCT_DEFAULTS,
  digitalProductFormSchema,
  saveDigitalProduct,
  setDigitalProductLifecycle,
  type DigitalProductFormValues,
} from "./adapters";
import {
  digitalProductQueryKey,
  type OwnedDigitalProduct,
} from "./load-offering";
import { ProductFilesManager } from "./ProductFilesManager";
import { MY_DIGITAL_PRODUCTS_QUERY_KEY } from "@/components/offerings/list/DigitalProductList";
import { sellHomeHref } from "@/lib/dashboard/sell-pages";

function formValuesOf(product: OwnedDigitalProduct): DigitalProductFormValues {
  return {
    title: product.title,
    subtitle: product.subtitle ?? "",
    description: product.description,
    category: product.category,
    price: product.pricePaise / 100,
    priceCurrency: "INR",
    coverImagePath: product.coverImagePath,
  };
}

function publishBlockedReason(
  product: OwnedDigitalProduct | undefined,
): string | null {
  if (!product)
    return "To publish, save a draft first, then add files in Files.";
  if (product.takenDownAt) return "This product was taken down.";
  if (product.assets.some((a) => a.status === "VERIFIED")) return null;
  return product.assets.some((a) => a.status === "PENDING")
    ? "To publish, finish verifying a file in Files."
    : "To publish, add a file that passes verification in Files.";
}

const archiveInsteadSchema = z.object({
  error: z.string(),
  code: z.enum(["HAS_PURCHASES", "HAS_ORDERS"]),
});

/** DELETE the product; one with a sale or a checkout is refused with the reason to archive it instead. */
async function deleteDigitalProduct(
  productId: string,
): Promise<{ archiveInstead: string } | null> {
  const res = await fetch(
    `/api/digital-products/${encodeURIComponent(productId)}`,
    { method: "DELETE" },
  );
  if (res.ok) return null;
  const body: unknown = await res.json().catch(() => null);
  const refusal = archiveInsteadSchema.safeParse(body);
  if (res.status === 409 && refusal.success) {
    return { archiveInstead: refusal.data.error };
  }
  throw new Error(errorMessageFromBody(body, "Couldn't delete the product"));
}

/**
 * The digital product editor: the shared offering shell over the product
 * routes. Saving creates or updates the listing; Publish and "Take off sale"
 * then flip its status, so a product is never live without a verified file.
 */
export function DigitalProductEditorContainer({
  consultantId,
  product,
}: Readonly<{ consultantId: string; product?: OwnedDigitalProduct }>) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [savingAction, setSavingAction] = React.useState<
    "draft" | "publish" | null
  >(null);
  const [stagedImage, setStagedImage] = React.useState<StagedPlanImage | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [archiveReason, setArchiveReason] = React.useState<string | null>(null);
  const form = useForm<DigitalProductFormValues>({
    resolver: zodResolver(digitalProductFormSchema),
    defaultValues: product ? formValuesOf(product) : DIGITAL_PRODUCT_DEFAULTS,
    mode: "onBlur",
  });

  const listHref = sellHomeHref(consultantId, "digital-product");
  const status = product?.status ?? null;
  const refresh = React.useCallback(
    () =>
      Promise.all([
        product
          ? queryClient.invalidateQueries({
              queryKey: digitalProductQueryKey(product.id),
            })
          : undefined,
        queryClient.invalidateQueries({
          queryKey: MY_DIGITAL_PRODUCTS_QUERY_KEY,
        }),
      ]),
    [product, queryClient],
  );

  const persist = async (
    values: DigitalProductFormValues,
    { publish }: { publish: boolean },
  ) => {
    setSavingAction(publish ? "publish" : "draft");
    try {
      const id = await saveDigitalProduct(values, product?.id);
      if (stagedImage && product) {
        await commitPlanImage("digital-products", id, stagedImage);
        setStagedImage(null);
      }
      if (publish && status !== "PUBLISHED") {
        await setDigitalProductLifecycle(id, "publish");
      } else if (!publish && status === "PUBLISHED") {
        await setDigitalProductLifecycle(id, "archive");
      }
      await refresh();

      if (!product) {
        toast({
          title: "Draft created",
          description: "Add your files, then publish it.",
        });
        router.replace(
          `/dashboard/consultant/${consultantId}/offerings/digital-product/${id}/edit`,
        );
        return;
      }
      if (publish) {
        toast({
          title: status === "PUBLISHED" ? "Changes saved" : "Product published",
        });
      } else if (status === "PUBLISHED") {
        toast({
          title: "Taken off sale",
          description: "Existing buyers keep their files.",
        });
        return;
      } else {
        toast({ title: "Draft saved" });
        return;
      }
      router.push(listHref);
    } catch (error) {
      // A 4xx is the server's answer, not a fault.
      if (!isExpectedRefusal(error)) {
        Sentry.captureException(
          error instanceof Error ? error : new Error(String(error)),
          { tags: { subsystem: "digital-products" } },
        );
      }
      toast({
        title: publish ? "Couldn't publish" : "Couldn't save",
        description:
          error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
      void refresh();
    } finally {
      setSavingAction(null);
    }
  };

  const closeDeleteDialog = (open: boolean) => {
    setConfirmDelete(open);
    if (!open) setArchiveReason(null);
  };

  const remove = async () => {
    if (!product) return;
    setDeleting(true);
    try {
      const refused = await deleteDigitalProduct(product.id);
      if (refused && status !== "ARCHIVED") {
        setArchiveReason(refused.archiveInstead);
        return;
      }
      if (refused) {
        toast({
          title: "Couldn't delete",
          description: refused.archiveInstead,
        });
      } else {
        await queryClient.invalidateQueries({
          queryKey: MY_DIGITAL_PRODUCTS_QUERY_KEY,
        });
        toast({ title: "Product deleted" });
        router.push(listHref);
      }
      closeDeleteDialog(false);
    } catch (error) {
      toast({
        title: "Couldn't delete",
        description:
          error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
      void refresh();
      closeDeleteDialog(false);
    } finally {
      setDeleting(false);
    }
  };

  const archiveInstead = async () => {
    if (!product) return;
    setDeleting(true);
    try {
      await setDigitalProductLifecycle(product.id, "archive");
      toast({
        title: "Product archived",
        description:
          "It's off sale, and anyone who bought it keeps their files.",
      });
    } catch (error) {
      toast({
        title: "Couldn't archive",
        description:
          error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      void refresh();
      setDeleting(false);
      closeDeleteDialog(false);
    }
  };

  const dialogAction = archiveReason
    ? { run: archiveInstead, label: "Archive", busy: "Archiving…" }
    : { run: remove, label: "Delete", busy: "Deleting…" };

  return (
    <>
      {product?.takenDownAt && (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <AlertTitle>This product was taken down</AlertTitle>
          <AlertDescription>
            {product.takedownReason ??
              "It breaks our content rules. Contact support if you think this is a mistake."}
          </AlertDescription>
        </Alert>
      )}
      <OfferingEditor
        manifest={DIGITAL_PRODUCT_MANIFEST}
        form={form}
        planId={product?.id}
        coverImage={
          product
            ? {
                staged: stagedImage,
                onStage: (image) => {
                  if (savingAction === null) setStagedImage(image);
                },
              }
            : undefined
        }
        status={status}
        draftLabel={status === "PUBLISHED" ? "Take off sale" : "Save draft"}
        previewHref={
          status === "PUBLISHED" && product
            ? `/explore/products/${product.slug}`
            : undefined
        }
        savingAction={savingAction}
        publishBlockedReason={publishBlockedReason(product)}
        headerActions={
          product && product.purchaseCount === 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={deleting || savingAction !== null}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Delete
            </Button>
          ) : undefined
        }
        slots={{
          files: product ? (
            <ProductFilesManager
              productId={product.id}
              category={product.category}
              isPublished={status === "PUBLISHED"}
              buyerCount={product.buyerCount}
              assets={product.assets}
              onChanged={refresh}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Save a draft first, then upload the files buyers get.
            </p>
          ),
        }}
        onSaveDraft={(values) => persist(values, { publish: false })}
        onPublish={(values) => persist(values, { publish: true })}
        onCancel={() => router.back()}
      />
      <AlertDialog open={confirmDelete} onOpenChange={closeDeleteDialog}>
        <AlertDialogContent>
          {archiveReason ? (
            <AlertDialogHeader>
              <AlertDialogTitle>Archive it instead?</AlertDialogTitle>
              <AlertDialogDescription>
                {archiveReason}. Archiving takes it off sale and keeps every
                purchase and checkout on record.
              </AlertDialogDescription>
            </AlertDialogHeader>
          ) : (
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this product?</AlertDialogTitle>
              <AlertDialogDescription>
                Its listing and files are deleted for good. You can delete it
                only while nobody has bought it or started a checkout; otherwise
                you can archive it.
              </AlertDialogDescription>
            </AlertDialogHeader>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void dialogAction.run();
              }}
            >
              {deleting ? dialogAction.busy : dialogAction.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
