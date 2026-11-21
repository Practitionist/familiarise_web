import * as Sentry from "@sentry/nextjs";

export const SYNTHETIC_DSN =
  "https://0123456789abcdef0123456789abcdef@o0123456789abcdef.ingest.us.sentry.io/0123456789abcdef";

type TransportOptions = Parameters<typeof Sentry.createTransport>[0];

/** A real SDK transport over a 30 ms fake HTTP layer that collects every delivered error event. */
export function slowCollectingTransport(delivered: Sentry.Event[]) {
  return (options: TransportOptions) =>
    Sentry.createTransport(options, async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const lines = String(request.body).split("\n").filter(Boolean);
      // Envelope: header line, then an (item header, payload) line pair per item.
      for (let i = 1; i + 1 < lines.length; i += 2) {
        if (JSON.parse(lines[i] ?? "{}").type === "event") {
          delivered.push(JSON.parse(lines[i + 1] ?? "{}") as Sentry.Event);
        }
      }
      return { statusCode: 200 };
    });
}
