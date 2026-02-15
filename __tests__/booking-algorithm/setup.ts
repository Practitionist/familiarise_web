/**
 * Setup file for booking-algorithm tests.
 * Polyfills TextEncoder/TextDecoder needed by Prisma client in jsdom.
 */

import { TextEncoder, TextDecoder } from "util";

if (typeof global.TextEncoder === "undefined") {
  (global as any).TextEncoder = TextEncoder;
}
if (typeof global.TextDecoder === "undefined") {
  (global as any).TextDecoder = TextDecoder;
}
