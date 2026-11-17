"use client";

import { createContext, useContext } from "react";

/**
 * Which of the two chat panes owns a narrow viewport (#1134).
 *
 * Lives in its own module because the consumer that needs `back` is
 * `CustomChannelHeader`, four levels below `ChatLayout` inside Stream's own
 * `<Channel><Window>` tree — prop drilling would have to pass through SDK
 * components, and importing the state from `ChatLayout` would close an import
 * cycle (ChatLayout → ChatContainer → CustomChannelHeader).
 *
 * The default is the desktop shape, so a chat component mounted outside the
 * layout still renders both panes rather than crashing.
 */
export interface ChatPaneState {
  /** True while the conversation covers the list below `md`. */
  conversationOpen: boolean;
  openConversation: () => void;
  /** Absent where there is no list to return to, such as the appointment chat sheet. */
  backToList?: () => void;
  /** The Messages link named a conversation the viewer can no longer open. */
  unavailableLink?: "event" | "conversation" | null;
  markLinkUnavailable?: (kind: "event" | "conversation") => void;
}

const ChatPaneContext = createContext<ChatPaneState>({
  conversationOpen: false,
  openConversation: () => {},
});

export const ChatPaneProvider = ChatPaneContext.Provider;

export const useChatPane = () => useContext(ChatPaneContext);
