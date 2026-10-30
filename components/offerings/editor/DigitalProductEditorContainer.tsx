"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import * as Sentry from "@sentry/nextjs";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  if (!product) return "Save a draft first, then add the files.";
  if (product.takenDownAt) return "This product was taken down.";
  if (!product.assets.some((a) => a.status === "VERIFIED")) {
    return "Add at least one verified file before publishing.";
  }
  return null;
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
  const form = useForm<DigitalProductFormValues>({
    resolver: zodResolver(digitalProductFormSchema),
    defaultValues: product ? formValuesOf(product) : DIGITAL_PRODUCT_DEFAULTS,
    mode: "onBlur",
  });

  const listHref = `/dashboard/consultant/${consultantId}/offerings/products`;
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
      } else {
        toast({ title: "Saved" });
      }
      router.push(listHref);
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "digital-products" } },
      );
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
        slots={{
          files: product ? (
            <ProductFilesManager
              productId={product.id}
              category={product.category}
              isPublished={status === "PUBLISHED"}
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
    </>
  );
}
