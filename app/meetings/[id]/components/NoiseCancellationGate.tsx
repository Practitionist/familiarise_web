"use client";

import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  NoiseCancellationProvider,
  NoiseCancellationSettingsModeEnum,
  OwnCapability,
  useCallStateHooks,
  useNoiseCancellation,
} from "@stream-io/video-react-sdk";
import { NoiseCancellation } from "@stream-io/audio-filters-web";

/**
 * Self-hosted Krisp model, same reasoning as the MediaPipe assets — the SDK
 * default is an unpkg.com fetch at runtime. `basePath` is the directory; the
 * SDK appends `krisp-nc-o-med-v7.kef` itself.
 */
const KRISP_BASE_PATH = "/nc-models";

interface NoiseCancellationGateValue {
  /** False hides the control entirely: no capability, no browser, or off for this call type. */
  available: boolean;
  /** Still probing browser support. */
  isChecking: boolean;
  isOn: boolean;
  isReady: boolean;
  toggle: () => void;
}

const GateContext = createContext<NoiseCancellationGateValue>({
  available: false,
  isChecking: false,
  isOn: false,
  isReady: false,
  toggle: () => {},
});

export const useNoiseCancellationGate = () => useContext(GateContext);

/**
 * Noise cancellation, off until asked for (#1134).
 *
 * This is a PAID Stream add-on billed per participant-minute, and the `default`
 * call type is configured `noise_cancellation.mode: "auto-on"`. Mounting
 * `NoiseCancellationProvider` therefore does not merely make the feature
 * available: the SDK calls `microphone.enableNoiseCancellation()`, sees
 * `auto-on` on a JOINED call, and switches it ON — which bills. A provider
 * mounted for everyone would have quietly added a per-minute charge to every
 * consultation on the platform the day this shipped.
 *
 * So the provider IS the switch. Off means unmounted: nothing initialised, no
 * 5.9MB Krisp model fetched, nothing billed.
 *
 * It is mounted as a SIBLING of `children` rather than around them. The control
 * lives inside a dropdown, and Radix unmounts closed menu content — a provider
 * nested in there would have been disposed the moment the menu closed, silently
 * turning the feature back off. Keeping it out here also means toggling does
 * not remount the menu under the user's cursor.
 */
export function NoiseCancellationGate({ children }: PropsWithChildren) {
  const { useCallSettings, useHasPermissions } = useCallStateHooks();
  const settings = useCallSettings();
  const hasCapability = useHasPermissions(
    OwnCapability.ENABLE_NOISE_CANCELLATION,
  );

  const noiseCancellation = useMemo(
    () => new NoiseCancellation({ basePath: KRISP_BASE_PATH }),
    [],
  );

  const [isSupportedByBrowser, setIsSupportedByBrowser] = useState<
    boolean | null
  >(null);
  const [isOn, setIsOn] = useState(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // `isSupported()` returns a boolean or a promise depending on the platform.
    void Promise.resolve(noiseCancellation.isSupported())
      .then((supported) => {
        if (!cancelled) setIsSupportedByBrowser(supported);
      })
      .catch(() => {
        if (!cancelled) setIsSupportedByBrowser(false);
      });
    return () => {
      cancelled = true;
    };
  }, [noiseCancellation]);

  const mode = settings?.audio.noise_cancellation?.mode;
  const available =
    hasCapability &&
    mode !== undefined &&
    mode !== NoiseCancellationSettingsModeEnum.DISABLED &&
    isSupportedByBrowser !== false;

  const toggle = useCallback(() => {
    setIsOn((on) => !on);
    setIsReady(false);
  }, []);

  const value = useMemo<NoiseCancellationGateValue>(
    () => ({
      available,
      isChecking: isSupportedByBrowser === null,
      isOn,
      isReady,
      toggle,
    }),
    [available, isSupportedByBrowser, isOn, isReady, toggle],
  );

  return (
    <GateContext.Provider value={value}>
      {children}
      {available && isOn && (
        <NoiseCancellationProvider noiseCancellation={noiseCancellation}>
          <NoiseCancellationBridge
            onReady={setIsReady}
            onUnsupported={() => setIsOn(false)}
          />
        </NoiseCancellationProvider>
      )}
    </GateContext.Provider>
  );
}

/**
 * Renders nothing. It exists to lift the provider's state back out to the gate,
 * so the row inside the dropdown can show it without the provider having to
 * live in there.
 */
function NoiseCancellationBridge({
  onReady,
  onUnsupported,
}: {
  onReady: (ready: boolean) => void;
  onUnsupported: () => void;
}) {
  const { isSupported, isReady, isEnabled, setEnabled } =
    useNoiseCancellation();
  const enabledOnce = useRef(false);

  useEffect(() => {
    onReady(isReady);
  }, [isReady, onReady]);

  // `auto-on` normally switches it on for us, but `available` — and a Krisp
  // `canAutoEnable` refusal — would not, and the person has just asked for it.
  useEffect(() => {
    if (isReady && !isEnabled && !enabledOnce.current) {
      enabledOnce.current = true;
      setEnabled(true);
    }
  }, [isReady, isEnabled, setEnabled]);

  // The provider re-derives support from the call's own settings. If it lands
  // on "no", fold back to off rather than leaving a dead switch on screen.
  useEffect(() => {
    if (isSupported === false) onUnsupported();
  }, [isSupported, onUnsupported]);

  return null;
}
