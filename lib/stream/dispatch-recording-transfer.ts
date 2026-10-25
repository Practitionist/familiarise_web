import { z } from "zod";

/** Queue admission only; the background core owns execution history and completion. */
export async function dispatchRecordingTransfer() {
  const secret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
  if (!secret)
    throw new Error("Recording worker authentication is unconfigured");
  const origin = z
    .string()
    .url()
    .parse(
      process.env.CRON_TICK_BASE_URL ||
        process.env.URL ||
        process.env.NEXT_PUBLIC_APP_URL,
    );
  const destination = new URL(
    "/.netlify/functions/recording-transfer-background",
    origin,
  );
  if (
    destination.protocol !== "https:" ||
    destination.username ||
    destination.password
  ) {
    throw new Error(
      "Recording worker requires a configured HTTPS origin without credentials",
    );
  }
  const response = await fetch(destination, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 202) {
    throw new Error(
      `Recording worker admission returned HTTP ${response.status}`,
    );
  }
  return { accepted: true, job: "transfer-recordings" };
}
