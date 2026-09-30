"use client";

/**
 * Granular cookie consent (#381 / #1230 wave-6a).
 *
 * Replaces the old accept/decline-only wrapper. Essential cookies are
 * always on; analytics, marketing, and functional are individually
 * toggleable. Preferences persist to the CookiePreference table via
 * /api/cookie-preferences (which was read-but-never-written since MVP).
 */

import { useCallback, useEffect, useState } from "react";
import CookieConsent from "react-cookie-consent";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

interface Prefs {
  analytics: boolean;
  marketing: boolean;
  functional: boolean;
}

const DEFAULTS: Prefs = {
  analytics: false,
  marketing: false,
  functional: false,
};

// #1527 3c — globals.css reserves this much at the end of every scrollport so
// the fixed bar never covers content. Unset whenever the bar is not shown.
const BAR_HEIGHT_VAR = "--cookie-bar-height";

function useReserveBarHeight() {
  const [bar, setBar] = useState<HTMLElement | null>(null);
  // Our content mounts and unmounts with the library's bar, so its container
  // is the element to measure.
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

// Equal weight: declining must be as easy to find as accepting.
const CHOICE_STYLE = {
  background: "#fafafa",
  color: "#18181b",
  fontSize: "13px",
  fontWeight: 500,
  borderRadius: "8px",
  padding: "8px 16px",
};

export default function CookieConsentBanner() {
  const [visible, setVisible] = useState(true);
  const [showPrefs, setShowPrefs] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const contentRef = useReserveBarHeight();

  useEffect(() => {
    fetch("/api/cookie-preferences")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.analytics === "boolean") setPrefs(d);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const [saveError, setSaveError] = useState(false);

  const save = async (p: Prefs): Promise<boolean> => {
    try {
      const res = await fetch("/api/cookie-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  if (!visible) return null;

  return (
    <CookieConsent
      location="bottom"
      buttonText="Accept all"
      declineButtonText="Essential only"
      enableDeclineButton
      cookieName="cookie_consent"
      style={{
        background: "rgba(9, 9, 11, 0.96)",
        backdropFilter: "blur(12px)",
        borderTop: "1px solid rgba(255, 255, 255, 0.1)",
        fontSize: "13px",
      }}
      buttonStyle={CHOICE_STYLE}
      declineButtonStyle={CHOICE_STYLE}
      expires={365}
      onAccept={() =>
        void save({ analytics: true, marketing: true, functional: true })
      }
      onDecline={() => void save(DEFAULTS)}
      overlay={false}
    >
      <div ref={contentRef} className="space-y-2">
        <p className="text-zinc-200">
          We use cookies to improve your experience. Essential cookies are
          always on.
        </p>
        {loaded && (
          <div>
            <Button
              size="sm"
              variant="ghost"
              className="text-zinc-400 hover:text-zinc-200 hover:bg-transparent underline text-xs h-auto p-0"
              onClick={(e) => {
                e.preventDefault();
                setShowPrefs((v) => !v);
              }}
            >
              {showPrefs ? "Hide preferences" : "Customize preferences"}
            </Button>
            {showPrefs && (
              <div className="mt-3 space-y-2.5 text-left">
                {(
                  [
                    ["analytics", "Analytics", "Usage tracking (GA4, Hotjar)"],
                    ["marketing", "Marketing", "Ad pixels, retargeting"],
                    ["functional", "Functional", "Chat widgets, video embeds"],
                  ] as Array<[keyof Prefs, string, string]>
                ).map(([key, label, desc]) => (
                  <div key={key} className="flex items-center gap-3">
                    <Switch
                      id={`cc-${key}`}
                      checked={prefs[key]}
                      onCheckedChange={(v) =>
                        setPrefs((prev) => ({ ...prev, [key]: v }))
                      }
                      className="data-[state=unchecked]:bg-zinc-700 data-[state=checked]:bg-white"
                    />
                    <Label
                      htmlFor={`cc-${key}`}
                      className="text-sm font-medium text-zinc-100 cursor-pointer"
                    >
                      {label}{" "}
                      <span className="text-xs font-normal text-zinc-400">
                        — {desc}
                      </span>
                    </Label>
                  </div>
                ))}
                <Button
                  size="sm"
                  className="bg-zinc-800 text-zinc-100 hover:bg-zinc-700 border border-zinc-700"
                  onClick={async () => {
                    const ok = await save(prefs);
                    if (ok) {
                      document.cookie = `cookie_consent=true; max-age=${365 * 24 * 3600}; path=/`;
                      setVisible(false);
                    } else {
                      setSaveError(true);
                    }
                  }}
                >
                  Save preferences
                </Button>
                {saveError && (
                  <p className="text-xs text-red-400">
                    Could not save — please try again.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </CookieConsent>
  );
}
