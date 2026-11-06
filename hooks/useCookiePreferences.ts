"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import {
  cookiePreferencesSchema,
  type CookiePreferenceUpdate,
} from "@/schemas/cookie-preferences";

export function useCookiePreferences() {
  const { data: session, isPending: identityPending } = useSession();
  const identity = session?.user?.id ?? "anonymous";
  const queryKey = ["cookie-preferences", identity];
  const client = useQueryClient();
  const query = useQuery({
    queryKey,
    enabled: !identityPending,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      const response = await fetch("/api/cookie-preferences");
      if (!response.ok)
        throw new Error("Cookie preferences could not be loaded");
      return cookiePreferencesSchema.parse(await response.json());
    },
  });
  const mutation = useMutation({
    mutationFn: async (updates: CookiePreferenceUpdate) => {
      if (identityPending)
        throw new Error("Your account state is still loading");
      const response = await fetch("/api/cookie-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!response.ok)
        throw new Error("Cookie preferences could not be saved");
      return cookiePreferencesSchema.parse(await response.json());
    },
    onMutate: () => ({ identity }),
    onSuccess: async (values, _updates, context) => {
      client.setQueryData(["cookie-preferences", context.identity], values);
      await client.invalidateQueries({
        queryKey: ["account-personal-consent", context.identity],
      });
    },
  });
  return { query, mutation, identity, identityPending };
}
