"use client";
import { useCallback, useEffect, useState } from "react";
import { useCookiePreferences } from "@/hooks/useCookiePreferences";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type { CookiePreferenceUpdate } from "@/schemas/cookie-preferences";

// Reserve the fixed banner's height so it cannot cover page content.
const BAR_HEIGHT_VAR = "--cookie-bar-height";

function useReserveBarHeight() {
  const [bar, setBar] = useState<HTMLElement | null>(null);
  // Measure the container while the banner is visible.
  const contentRef = useCallback((node: HTMLDivElement | null) => {
    setBar(node?.closest<HTMLElement>(".CookieConsent") ?? null);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (!bar) return;
    const publish = () =>
      root.style.setProperty(BAR_HEIGHT_VAR, `${bar.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.style.removeProperty(BAR_HEIGHT_VAR);
    };
  }, [bar]);
  return contentRef;
}

export default function CookieConsentBanner() {
  const { query, mutation, identity, identityPending } = useCookiePreferences();
  const [visible, setVisible] = useState(false);
  const [customize, setCustomize] = useState(false);
  const [draft, setDraft] = useState<{
    identity: string;
    values: { analytics: boolean; marketing: boolean };
  } | null>(null);
  const [saveError, setSaveError] = useState(false);
  const contentRef = useReserveBarHeight();
  useEffect(() => {
    const acknowledged = document.cookie
      .split(";")
      .some((value) => /^cookie_consent=(true|false)$/.test(value.trim()));
    setVisible(!acknowledged);
  }, []);
  const prefs = (draft?.identity === identity ? draft.values : null) ??
    query.data ?? { analytics: false, marketing: false };
  const save = async (values: CookiePreferenceUpdate) => {
    setSaveError(false);
    try {
      await mutation.mutateAsync(values);
      document.cookie = `cookie_consent=true; max-age=${365 * 86400}; path=/; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`;
      setVisible(false);
    } catch {
      setSaveError(true);
    }
  };
  if (!visible) return null;
  return (
    <section
      role="region"
      aria-label="Cookie preferences"
      className="CookieConsent fixed inset-x-0 bottom-0 z-50 bg-zinc-900 p-4 text-sm text-white"
    >
      <div ref={contentRef} className="mx-auto max-w-6xl space-y-3">
        <p>
          Essential cookies support sign-in and checkout. Optional choices
          record permission for analytics and advertising cookies; they never
          subscribe you to emails. Essential sign-in and checkout remain
          available either way.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            variant="secondary"
            disabled={mutation.isPending || identityPending}
            onClick={() => void save({ analytics: true, marketing: true })}
          >
            Allow optional cookies
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={mutation.isPending || identityPending}
            onClick={() => void save({ analytics: false, marketing: false })}
          >
            Essential only
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={mutation.isPending || identityPending}
            onClick={() => setCustomize((value) => !value)}
          >
            Choose cookies
          </Button>
        </div>
        {customize && (
          <div className="space-y-3">
            {query.isError && (
              <p role="alert">
                Saved choices could not be loaded.{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => void query.refetch()}
                >
                  Retry
                </button>
              </p>
            )}
            {(["analytics", "marketing"] as const).map((key) => (
              <div key={key} className="flex items-center gap-3">
                <Switch
                  id={`cc-${key}`}
                  checked={prefs[key]}
                  disabled={!query.data || query.isError || mutation.isPending}
                  onCheckedChange={(checked) =>
                    setDraft({ identity, values: { ...prefs, [key]: checked } })
                  }
                />
                <Label htmlFor={`cc-${key}`}>
                  {key === "analytics"
                    ? "Analytics cookies"
                    : "Marketing cookies"}
                </Label>
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              disabled={!query.data || query.isError || mutation.isPending}
              onClick={() =>
                void save({
                  analytics: prefs.analytics,
                  marketing: prefs.marketing,
                })
              }
            >
              Save cookie choices
            </Button>
          </div>
        )}
        {saveError && (
          <p role="alert">
            Your cookie choices were not saved. Please try again.
          </p>
        )}
      </div>
    </section>
  );
}
