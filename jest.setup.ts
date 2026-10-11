import "@testing-library/jest-dom";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

// Suites send to example addresses; the pre-launch guard's own pin unsets this.
process.env.EMAIL_DELIVERY_MODE ??= "live";

import { ReadableStream } from "stream/web";

// jsdom omits Node's built-in Fetch/WebStreams globals that server SDKs reference at module load.
if (typeof globalThis.Request === "undefined") {
  globalThis.Request = class Request {} as unknown as typeof globalThis.Request;
}
if (typeof globalThis.Response === "undefined") {
  globalThis.Response =
    class Response {} as unknown as typeof globalThis.Response;
}
if (typeof globalThis.Headers === "undefined") {
  globalThis.Headers = class Headers {} as unknown as typeof globalThis.Headers;
}
if (typeof globalThis.ReadableStream === "undefined") {
  globalThis.ReadableStream =
    ReadableStream as unknown as typeof globalThis.ReadableStream;
}
