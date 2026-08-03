"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentType,
} from "react";

// Re-export the logout helper from the SDK-free module so existing importers of
// `disconnectStreamClients` from this path keep working unchanged. Callers that
// ONLY need disconnect should import it straight from "@/lib/stream/disconnect"
// to stay off the SDK bundle entirely (Navbar already does — see #248).
export { disconnectStreamClients } from "@/lib/stream/disconnect";

// ── Connection-state context ────────────────────────────────────────────────
// Defined in this SDK-free shell (not the heavy impl) so consumers like
// DebugDialog can import useStreamConnection without pulling the SDK, and so the
// context identity is stable across the lazy boundary. The heavy impl imports
// this same context and pushes the live value into it once connected.

export interface StreamConnectionState {
  chatConnected: boolean;
  videoConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  retryConnection: () => void;
}

// Default (impl-not-yet-loaded) connection state. Returned by
// useStreamConnection while the dynamic impl is still loading so consumers never
// crash during the lazy-load window. Previously useStreamConnection threw when
// used outside the provider; the dashboard never relied on that throw in prod,
// and a safe default is required now that the provider is lazy.
const DEFAULT_CONNECTION_STATE: StreamConnectionState = {
  chatConnected: false,
  videoConnected: false,
  isConnecting: false,
  error: null,
  retryConnection: () => {},
};

export const StreamConnectionContext = createContext<StreamConnectionState>(
  DEFAULT_CONNECTION_STATE,
);

export const useStreamConnection = (): StreamConnectionState => {
  return useContext(StreamConnectionContext);
};

export interface StreamProviderProps {
  children: React.ReactNode;
  userId: string;
  enableChat?: boolean;
  enableVideo?: boolean;
}

/**
 * SDK-free shell. Always paints `children` immediately, then upgrades to the
 * Stream SDK impl once its chunk loads.
 *
 * Why not `next/dynamic` with a loading spinner: that fallback *replaced*
 * children during chunk download, so every dashboard route (including /home)
 * blocked on the Stream bundle. The unread badge + Join still need the layout
 * to mount this provider (singleton connect), but they must not gate first
 * paint. Websocket connect itself stays deferred to requestIdleCallback inside
 * the impl (#248).
 */
const StreamProvider = (props: StreamProviderProps) => {
  const [Impl, setImpl] = useState<ComponentType<StreamProviderProps> | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void import("@/providers/StreamProviderImpl").then((mod) => {
      if (!cancelled) setImpl(() => mod.default);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!Impl) {
    return (
      <StreamConnectionContext.Provider value={DEFAULT_CONNECTION_STATE}>
        {props.children}
      </StreamConnectionContext.Provider>
    );
  }

  return <Impl {...props} />;
};

export default StreamProvider;
