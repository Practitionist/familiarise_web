"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { PanelHeader } from "@/components/dashboard/PageScaffold";
import { Section } from "@/components/dashboard/Section";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field-error";
import { useToast } from "@/hooks/use-toast";
import { errorMessageFromBody } from "@/lib/fetch-helpers";
import {
  fetchOrgDetails,
  orgDetailsQueryKey,
} from "@/lib/api/organizations/org-details";

type Asset = "logo" | "banner";

const ASSETS: Record<
  Asset,
  { title: string; description: string; limit: string }
> = {
  logo: {
    title: "Logo",
    description:
      "Shown in the dashboard, on invoices and on your public page. Square works best.",
    limit: "JPEG, PNG, WebP or SVG, up to 2 MB.",
  },
  banner: {
    title: "Banner",
    description: "The wide image across the top of your public page.",
    limit: "JPEG, PNG, WebP or SVG, up to 5 MB.",
  },
};

function AssetSection({
  orgId,
  asset,
  currentUrl,
}: Readonly<{ orgId: string; asset: Asset; currentUrl: string | null }>) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const meta = ASSETS[asset];
  const url = `/api/organizations/${orgId}/branding/${asset}`;

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: orgDetailsQueryKey(orgId) });

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(url, { method: "POST", body: form });
      const body = await res.json().catch(() => null);
      if (!res.ok)
        throw new Error(errorMessageFromBody(body, "Upload failed."));
      await refresh();
      toast({ title: `${meta.title} updated` });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const remove = async () => {
    const res = await fetch(url, { method: "DELETE" });
    const body = await res.json().catch(() => null);
    // Thrown messages surface inside the ConfirmDialog.
    if (!res.ok)
      throw new Error(errorMessageFromBody(body, "Couldn't remove it."));
    await refresh();
  };

  return (
    <Section title={meta.title} description={meta.description} variant="card">
      <div className="flex flex-wrap items-center gap-4">
        {currentUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- user-uploaded asset on a dynamic host
          <img
            src={currentUrl}
            alt={`Current ${meta.title.toLowerCase()}`}
            className="h-16 max-w-[240px] rounded-md border border-border object-contain"
          />
        )}
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/svg+xml"
          className="hidden"
          aria-label={`Upload ${meta.title.toLowerCase()}`}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? "Uploading…" : `Upload ${meta.title.toLowerCase()}`}
        </Button>
        {currentUrl && (
          <ConfirmDialog
            title={`Remove the ${meta.title.toLowerCase()}?`}
            description="It disappears from the dashboard, invoices and your public page."
            confirmLabel="Remove"
            tone="destructive"
            onConfirm={remove}
            trigger={
              <Button variant="ghost" size="sm">
                Remove
              </Button>
            }
          />
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{meta.limit}</p>
      <FieldError message={error} />
    </Section>
  );
}

/**
 * Settings › Branding (#1527 Q6): logo and banner through
 * `…/branding/[asset]` POST/DELETE, OWNER-only on the server and in the tab.
 */
export function BrandingPanel({ orgId }: Readonly<{ orgId: string }>) {
  const { data } = useQuery({
    queryKey: orgDetailsQueryKey(orgId),
    queryFn: () => fetchOrgDetails(orgId),
    staleTime: 60_000,
  });
  return (
    <>
      <PanelHeader description="How your organization looks to members and on your public page." />
      <AssetSection
        orgId={orgId}
        asset="logo"
        currentUrl={data?.organization.logo ?? null}
      />
      {/* The org details read carries no banner URL; upload replaces it. */}
      <AssetSection orgId={orgId} asset="banner" currentUrl={null} />
    </>
  );
}
