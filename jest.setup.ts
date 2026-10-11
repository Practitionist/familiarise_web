import "@testing-library/jest-dom";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

// Suites send to example addresses; the pre-launch guard's own pin unsets this.
process.env.EMAIL_DELIVERY_MODE ??= "live";

import { ReadableStream } from "node:stream/web";

// jsdom omits Node's built-in Fetch/WebStreams globals that server SDKs reference at module load.
globalThis.Request ??=
  function Request() {} as unknown as typeof globalThis.Request;
globalThis.Response ??=
  function Response() {} as unknown as typeof globalThis.Response;
globalThis.Headers ??=
  function Headers() {} as unknown as typeof globalThis.Headers;
globalThis.ReadableStream ??=
  ReadableStream as unknown as typeof globalThis.ReadableStream;
