"use server";

import { fetchUserDetails } from "@/hooks/useUserData";
import { StreamClient } from "@stream-io/node-sdk";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const apiSecret = process.env.STREAM_API_SECRET;

export const tokenProvider = async (userId: string) => {
    try {
        const userDetails = await fetchUserDetails(userId);

        if (!userDetails) throw new Error("User not found");
        if (!apiKey) throw new Error("Stream API key not configured");
        if (!apiSecret) throw new Error("Stream API secret not configured");

        const client = new StreamClient(apiKey, apiSecret);

        const exp = Math.round(Date.now() / 1000) + 60 * 60; // 1 hour
        const issued = Math.round(Date.now() / 1000) - 60; // 1 minute ago

        // Generate user token with the correct payload structure
        const token = client.generateUserToken({
            user_id: userDetails.id,
            exp,
            iat: issued
        });

        return token;
    } catch (error) {
        console.error("Error generating token:", error);
        throw error;
    }
}
