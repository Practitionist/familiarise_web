"use client";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { inboxRestrictionsSchema } from "@/schemas/inbox-preferences";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";

export function InboxPreferenceStatus({
  userId,
}: {
  userId: string | undefined;
}) {
  const status = useQuery({
    queryKey: ["inbox-preferences", userId],
    enabled: Boolean(userId),
    retry: false,
    queryFn: async () => {
      const response = await fetch("/api/novu/preferences/inbox");
      if (!response.ok) throw new Error("Inbox preferences unavailable");
      return inboxRestrictionsSchema.parse(await response.json());
    },
  });
  if (status.isError)
    return (
      <div className="rounded-lg border p-3 text-sm" role="status">
        We couldn&apos;t check earlier inbox-only choices. Your saved settings
        are unchanged.{" "}
        <Button variant="link" size="sm" onClick={() => void status.refetch()}>
          Retry
        </Button>
      </div>
    );
  if (
    !status.data ||
    (!status.data.globalMuted && status.data.workflows.length === 0)
  )
    return null;
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm" role="status">
      <p className="font-medium">Earlier inbox-only choices still apply</p>
      <p>
        {status.data.globalMuted
          ? "Your inbox is muted by an earlier preference."
          : "Some inbox categories were muted in the previous inbox settings."}{" "}
        Email settings are unaffected.
      </p>
      {status.data.workflows.length > 0 && (
        <p>
          Muted categories:{" "}
          {status.data.workflows.map((item) => item.name).join(", ")}.
        </p>
      )}
      <ConfirmDialog
        title="Use the settings on this page for your inbox?"
        description="This replaces earlier inbox-only restrictions. Inbox categories allowed on this page can receive future notifications; paused categories remain paused. Email choices and cookie consent are unchanged."
        confirmLabel="Use these settings"
        trigger={
          <Button variant="outline" size="sm">
            Use the settings on this page
          </Button>
        }
        onConfirm={async () => {
          const response = await fetch("/api/novu/preferences/inbox", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ useFamiliariseSettings: true }),
          });
          if (!response.ok) {
            const parsed = z
              .object({ error: z.string() })
              .safeParse(await response.json().catch(() => null));
            throw new Error(
              parsed.success
                ? parsed.data.error
                : "Inbox settings could not be confirmed. Try again.",
            );
          }
          const updated = inboxRestrictionsSchema.parse(await response.json());
          if (updated.globalMuted || updated.workflows.length > 0)
            throw new Error(
              "Some earlier inbox choices still apply. Try again.",
            );
          await status.refetch();
        }}
      />
    </div>
  );
}
