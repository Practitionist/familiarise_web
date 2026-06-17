"use client";

import { createContext, useContext } from "react";
import dynamic from "next/dynamic";

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

// Loading strategy (deliberate, per-scenario — NOT blanket lazy):
//
//  • SDK code-split (lazy chunk): YES. The Stream SDK is heavy and the dashboard
//    LANDING route is always /home, which renders no chat/video UI. Splitting the
//    SDK + its two stylesheets into a chunk keeps them out of /home's synchronous
//    bundle, so /home parses/paints without paying for the SDK up front.
//
//  • When does that chunk actually load? On dashboard routes the provider is
//    mounted by the LAYOUT, so the chunk begins downloading on /home too — but
//    IN PARALLEL, off the critical bundle, not blocking first paint. This is the
//    right call (deferred/parallel, not "only when chat opens") because the
//    consultant sidebar shows a chat-unread badge on every route incl. /home,
//    which needs the chat client connected. Gating the whole provider behind
//    "user opened chat" would break that badge. The actual connect (websocket)
//    is further deferred to requestIdleCallback inside the impl (see #248 there).
//
//  • ssr:false: the SDK is browser-only (websockets/WebRTC); SSR-ing it is wasted
//    server work and hydration mismatch risk.
//
// Children are rendered through the impl, which renders them DIRECTLY even before
// connection completes (it no longer blocks on a spinner until connected). During
// the brief chunk-download window the fallback below shows — this is strictly
// shorter than the previous behavior, which blocked children until BOTH clients
// finished their websocket handshake.
function StreamProviderLoading() {
  return (
    <div className="flex items-center justify-center min-h-[200px]">
      <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary" />
    </div>
  );
}

const LazyStreamProviderImpl = dynamic(
  () => import("@/providers/StreamProviderImpl"),
  { ssr: false, loading: () => <StreamProviderLoading /> },
);

/**
 * SDK-free shell. Renders children through the lazily-loaded implementation,
 * which provides the chat/video contexts + connection lifecycle once its chunk
 * loads. The impl renders children directly even before connection completes;
 * video consumers already guard a null client, and chat consumers only render on
 * the chat route (under <Chat>).
 */
const StreamProvider = (props: StreamProviderProps) => {
  return <LazyStreamProviderImpl {...props} />;
};

export default StreamProvider;
