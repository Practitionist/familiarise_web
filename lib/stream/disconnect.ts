// SDK-free module that owns the shared module-level Stream client refs and the
// logout disconnect helper. Split out of StreamProvider so SDK-free callers
// (Navbar, UserDropdown, org/admin/staff layouts) that only need
// disconnectStreamClients no longer statically link the heavy Stream
// video/chat SDK into their bundles. Types are `import type` only (erased at
// runtime); we never construct an SDK class here, only call methods on already-
// instantiated client objects, so this file imports no SDK runtime code.

import type { StreamChat } from "stream-chat";
import type { StreamVideoClient } from "@stream-io/video-react-sdk";
import { streamLogger } from "@/lib/stream-logger";
import { clearAllStreamCaches } from "@/lib/stream-cache";

// Module-level client instances to avoid re-creating on remount.
// Owned here (not in StreamProvider) so the disconnect helper and the provider
// share one source of truth without the helper dragging in the SDK.
let globalChatClient: StreamChat | null = null;
let globalVideoClient: StreamVideoClient | null = null;
let currentUserId: string | null = null;

// Accessors/mutators used by StreamProvider. The provider reads/writes these
// shared refs through these functions instead of owning the module state.
export function getGlobalChatClient(): StreamChat | null {
  return globalChatClient;
}
export function setGlobalChatClient(client: StreamChat | null): void {
  globalChatClient = client;
}
export function getGlobalVideoClient(): StreamVideoClient | null {
  return globalVideoClient;
}
export function setGlobalVideoClient(client: StreamVideoClient | null): void {
  globalVideoClient = client;
}
export function getCurrentStreamUserId(): string | null {
  return currentUserId;
}
export function setCurrentStreamUserId(userId: string | null): void {
  currentUserId = userId;
}

/**
 * Disconnect all Stream clients and clear global state.
 * Call this before signing out to ensure clean disconnection.
 */
export async function disconnectStreamClients(): Promise<void> {
  const promises: Promise<void>[] = [];

  if (globalChatClient) {
    const client = globalChatClient;
    promises.push(
      client.disconnectUser().then(() => {
        streamLogger.debug("Chat client disconnected on logout");
      }),
    );
  }

  if (globalVideoClient) {
    const videoClient = globalVideoClient;
    promises.push(
      videoClient.disconnectUser().then(() => {
        streamLogger.debug("Video client disconnected on logout");
      }),
    );
  }

  await Promise.all(promises);

  // Nullify references only after disconnect completes to avoid
  // another code path creating a new client while still disconnecting
  globalChatClient = null;
  globalVideoClient = null;
  currentUserId = null;
  clearAllStreamCaches();

  // Clear sessionStorage sync flags so a re-login triggers a fresh sync
  if (typeof sessionStorage !== "undefined") {
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith("stream_sync_"))
      .forEach((k) => sessionStorage.removeItem(k));
  }
}
