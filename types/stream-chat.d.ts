import { StreamChat, Channel, UserResponse } from "stream-chat";
import { User } from "@prisma/client";

// Define the custom types for Stream Chat
declare module "stream-chat" {
  interface StreamChatOptions {
    timeout?: number;
    logger?: (logLevel: string, message: string, extraData?: any) => void;
  }

  interface UserResponse {
    id: string;
    role?: string;
    name?: string;
    image?: string;
  }
}

// Define the custom types for Stream Chat React
declare module "stream-chat-react" {
  export interface ChatContextValue {
    client: StreamChat;
    channel?: Channel;
    setActiveChannel?: (channel: Channel) => void;
  }

  export interface ChannelListMessengerProps {
    children?: React.ReactNode;
    error?: boolean;
    loading?: boolean;
    loadingChannels?: boolean;
    LoadingErrorIndicator?: React.ComponentType;
    LoadingIndicator?: React.ComponentType;
    setChannels?: (channels: Channel[]) => void;
  }

  export interface MessageProps {
    client: StreamChat;
    message?: any;
    lastReceivedId?: string;
    groupStyles?: string[];
    messageListRect?: DOMRect;
    onReactionListClick?: () => void;
    onUserClick?: (e: React.MouseEvent) => void;
    onUserHover?: (e: React.MouseEvent) => void;
    reactionSelectorRef?: React.RefObject<HTMLDivElement>;
    showDetailedReactions?: boolean;
    threadList?: boolean;
  }
}

// Define the custom types for our application
export type StreamChatUser = {
  id: string;
  name?: string;
  image?: string;
  role?: User["role"];
};
