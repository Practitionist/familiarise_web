/**
 * Centralized Novu Client Manager
 * Provides singleton instance for server-side Novu API interactions.
 * Pattern follows lib/stream-client.ts
 */
import { Novu } from "@novu/api";

const NOVU_SECRET_KEY = process.env.NOVU_SECRET_KEY;

let novuInstance: Novu | null = null;

export function isNovuConfigured(): boolean {
  return !!NOVU_SECRET_KEY;
}

export function validateNovuConfig(): void {
  if (!NOVU_SECRET_KEY) {
    throw new Error(
      "NOVU_SECRET_KEY is not configured. Please set it in your environment variables.",
    );
  }
}

export function getNovuClient(): Novu {
  validateNovuConfig();

  if (!novuInstance) {
    novuInstance = new Novu({ secretKey: NOVU_SECRET_KEY! });
  }

  return novuInstance;
}

export function resetNovuClient(): void {
  novuInstance = null;
}
