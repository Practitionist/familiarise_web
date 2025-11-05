"use server";

import { fetchUserDetails, mapRoleToStream } from "@/lib/user";
import { StreamClient } from "@stream-io/node-sdk";
import { StreamChat } from "stream-chat";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const apiSecret = process.env.STREAM_API_SECRET;

// Video token provider (Stream Video)
export const tokenProvider = async (userId: string) => {
  try {
    const userDetails = await fetchUserDetails(userId);

    if (!userDetails) throw new Error("User not found");
    if (!apiKey) throw new Error("Stream API key not configured");
    if (!apiSecret) throw new Error("Stream API secret not configured");

    const client = new StreamClient(apiKey, apiSecret);

    const exp = Math.round(Date.now() / 1000) + 60 * 60; // 1 hour
    const issued = Math.round(Date.now() / 1000) - 60; // 1 minute ago

    // Use the shared utility function
    const streamRole = mapRoleToStream(userDetails.role);

    console.log(
      `Generating token for user ${userDetails.id} with role ${streamRole}`,
    );

    // Generate user token with the correct payload structure
    const token = client.generateUserToken({
      user_id: userDetails.id,
      exp,
      iat: issued,
    });

    return token;
  } catch (error) {
    console.error("Error generating token:", error);
    throw error;
  }
};

// Chat token provider (Stream Chat)
export const chatTokenProvider = async (userId: string) => {
  try {
    if (!apiKey) throw new Error("Stream API key not configured");
    if (!apiSecret) throw new Error("Stream API secret not configured");

    // Optionally verify user exists in DB
    const userDetails = await fetchUserDetails(userId);
    if (!userDetails) throw new Error("User not found");

    const serverClient = StreamChat.getInstance(apiKey, apiSecret);
    const token = serverClient.createToken(userDetails.id);
    return token;
  } catch (error) {
    console.error("Error generating chat token:", error);
    throw error;
  }
};
