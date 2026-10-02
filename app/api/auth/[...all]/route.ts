import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { withRetryAfter } from "@/lib/auth/rate-limit";

const handler = toNextJsHandler(auth);

export const GET = async (request: Request) =>
  withRetryAfter(await handler.GET(request));

export const POST = async (request: Request) =>
  withRetryAfter(await handler.POST(request));
