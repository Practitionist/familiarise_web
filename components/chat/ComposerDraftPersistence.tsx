"use client";

import { useEffect } from "react";
import { useMessageComposerController } from "stream-chat-react";

const DRAFT_KEY_PREFIX = "chat-draft:";

// sessionStorage can be absent (SSR) or throw (Safari private mode, quota); a lost draft must never break chat.
function readDraft(cid: string): string {
  try {
    return window.sessionStorage.getItem(DRAFT_KEY_PREFIX + cid) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(cid: string, text: string): void {
  try {
    if (text === "") window.sessionStorage.removeItem(DRAFT_KEY_PREFIX + cid);
    else window.sessionStorage.setItem(DRAFT_KEY_PREFIX + cid, text);
  } catch {
    // Persistence is best effort.
  }
}

/**
 * Keeps the unsent composer text per channel in sessionStorage so it survives the chat layout
 * remounting after a long socket outage; an emptied composer (including after a send) clears it.
 */
export function ComposerDraftPersistence() {
  const composer = useMessageComposerController();
  const cid = composer.channel.cid;

  useEffect(() => {
    const { textComposer } = composer;
    if (textComposer.text === "") {
      const draft = readDraft(cid);
      if (draft) textComposer.setText(draft);
    }
    return textComposer.state.subscribeWithSelector(
      (state) => ({ text: state.text }),
      ({ text }) => {
        // Editing a sent message loads its text into the composer; that is not a draft.
        if (!composer.editedMessage) writeDraft(cid, text);
      },
    );
  }, [composer, cid]);

  return null;
}
