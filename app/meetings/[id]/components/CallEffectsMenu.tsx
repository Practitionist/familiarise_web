"use client";

import { useBackgroundFilters } from "@stream-io/video-react-sdk";
import { Aperture, MicVocal, Wand2 } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EffectRow } from "./EffectRow";
import { useNoiseCancellationGate } from "./NoiseCancellationGate";

/**
 * Background blur and noise cancellation, in one menu (#1134).
 *
 * Both are privacy controls before they are polish: a consultation is often
 * taken from a kitchen or a shared flat, and until now the only way to keep a
 * room out of a session was to turn the camera off altogether.
 */
export function CallEffectsMenu() {
  const {
    isSupported,
    isReady,
    isLoading,
    backgroundFilter,
    applyBackgroundBlurFilter,
    disableBackgroundFilter,
  } = useBackgroundFilters();

  const noiseCancellation = useNoiseCancellationGate();

  const blurOn = backgroundFilter === "blur";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="rounded-xl bg-zinc-800 p-3 transition-colors hover:bg-zinc-700"
          title="Effects"
          aria-label="Background and audio effects"
        >
          <Wand2 className="h-5 w-5 text-white" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="center"
        className="min-w-[260px] rounded-xl border-zinc-800 bg-zinc-900 p-2"
        sideOffset={12}
      >
        <DropdownMenuLabel className="px-3 py-1.5 text-xs font-normal text-zinc-500">
          Effects
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-zinc-800" />

        {isSupported ? (
          <EffectRow
            icon={Aperture}
            label="Blur my background"
            hint={
              isLoading ? "Applying…" : isReady ? "Hides your room" : "Loading…"
            }
            active={blurOn}
            disabled={!isReady || isLoading}
            loading={isLoading || !isReady}
            onToggle={() => {
              if (blurOn) disableBackgroundFilter();
              else applyBackgroundBlurFilter("high");
            }}
          />
        ) : (
          // Safari is excluded by the SDK on purpose — see CallFiltersProvider.
          <p className="px-3 py-2.5 text-xs text-zinc-500">
            Background blur is not available in this browser. Chrome, Edge and
            Firefox support it.
          </p>
        )}

        {noiseCancellation.available && (
          <EffectRow
            icon={MicVocal}
            label="Reduce background noise"
            hint={
              !noiseCancellation.isOn
                ? "Filters keyboards, traffic and fans out of your microphone"
                : noiseCancellation.isReady
                  ? "On"
                  : "Starting…"
            }
            active={noiseCancellation.isOn && noiseCancellation.isReady}
            disabled={noiseCancellation.isChecking}
            loading={noiseCancellation.isOn && !noiseCancellation.isReady}
            onToggle={noiseCancellation.toggle}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
