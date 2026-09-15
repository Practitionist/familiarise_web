/**
 * @jest-environment node
 */

/**
 * The server-minted tokens seed the connector's cache only for the user they
 * were minted for and only inside the cache window, and only for the types
 * that were minted — so a stale or foreign seed falls back to the token
 * action rather than connecting with the wrong identity. FAMILIARISE_WEB-4A
 */

import { seedFromInitialTokens } from "@/lib/stream/seed-token-cache";

const NOW = 1_700_000_000_000;

describe("seedFromInitialTokens", () => {
  it("seeds the minted types for the matching user before expiry", () => {
    const both = {
      userId: "u1",
      chatToken: "chat.jwt",
      videoToken: "video.jwt",
      expiresAt: NOW + 1000,
    };
    expect(seedFromInitialTokens(both, "u1", NOW)).toEqual({
      chatToken: "chat.jwt",
      chatExpiresAt: NOW + 1000,
      videoToken: "video.jwt",
      videoExpiresAt: NOW + 1000,
    });

    const videoOnly = {
      userId: "u1",
      videoToken: "video.jwt",
      expiresAt: NOW + 1,
    };
    expect(seedFromInitialTokens(videoOnly, "u1", NOW)).toEqual({
      videoToken: "video.jwt",
      videoExpiresAt: NOW + 1,
    });
  });

  it("returns null for another user, after expiry, or with no seed", () => {
    const seed = { userId: "u1", chatToken: "chat.jwt", expiresAt: NOW + 1000 };
    expect(seedFromInitialTokens(seed, "u2", NOW)).toBeNull();
    expect(seedFromInitialTokens(seed, "u1", NOW + 1000)).toBeNull();
    expect(seedFromInitialTokens(null, "u1", NOW)).toBeNull();
  });
});
