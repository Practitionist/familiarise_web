"use client";

import {
  createClassChannel,
  createConsultationChannel,
  createSubscriptionChannel,
  createWebinarChannel,
} from "@/actions/stream/chat/channel.action";
import { useEffect, useState } from "react";

type ChannelCreationProps = {
  type: "consultation" | "subscription" | "webinar" | "class";
  id: string;
};

export const useChannelCreation = ({ type, id }: ChannelCreationProps) => {
  const [isCreating, setIsCreating] = useState(false);
  const [isCreated, setIsCreated] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const createChannel = async () => {
      if (!id) return;

      setIsCreating(true);
      setError(null);

      try {
        let result;

        switch (type) {
          case "consultation":
            result = await createConsultationChannel(id);
            break;
          case "subscription":
            result = await createSubscriptionChannel(id);
            break;
          case "webinar":
            result = await createWebinarChannel(id);
            break;
          case "class":
            result = await createClassChannel(id);
            break;
          default:
            throw new Error(`Invalid channel type: ${type}`);
        }

        console.log(`Created ${type} channel:`, result);
        setIsCreated(true);
      } catch (err) {
        console.error(`Error creating ${type} channel:`, err);
        setError(err as Error);
      } finally {
        setIsCreating(false);
      }
    };

    createChannel();
  }, [type, id]);

  return { isCreating, isCreated, error };
};
