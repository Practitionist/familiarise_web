"use client";

import { useEffect } from "react";
import { useMessageComposerController } from "stream-chat-react";
import { CHAT_DRAFT_KEY_PREFIX } from "@/lib/stream/disconnect";

// sessionStorage can be absent (SSR) or throw (Safari private mode, quota); a lost draft must never break chat.
function readDraft(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string, text: string): void {
  try {
    if (text === "") window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, text);
  } catch {
    // Persistence is best effort.
  }
}

/**
 * Keeps the unsent composer text per user and channel in sessionStorage so it survives the chat layout
 * remounting after a long socket outage; an emptied composer (including after a send) clears it.
 */
export function ComposerDraftPersistence() {
  const composer = useMessageComposerController();
  const userId = composer.channel.getClient().userID;
  const key = userId
    ? `${CHAT_DRAFT_KEY_PREFIX}${userId}:${composer.channel.cid}`
    : null;

  useEffect(() => {
    if (!key) return;
    const { textComposer } = composer;
    if (textComposer.text === "") {
      const draft = readDraft(key);
      if (draft) textComposer.setText(draft);
    }
    return textComposer.state.subscribeWithSelector(
      (state) => ({ text: state.text }),
      ({ text }) => {
        // Editing a sent message loads its text into the composer; that is not a draft.
        if (!composer.editedMessage) writeDraft(key, text);
      },
    );
  }, [composer, key]);

  return null;
}
