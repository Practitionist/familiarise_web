import { randomUUID } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { z } from "zod";
import { DisplayNameSchema } from "@/schemas/auth";

const NAME_PATHS = new Set(["/sign-up/email", "/update-user"]);

const BodySchema = z.record(z.string(), z.unknown());
const SignUpBodySchema = z.object({
  email: z.string(),
  name: z.string(),
});

// `token` is null, or already stripped by lib/auth/strip-session-token.ts.
const SignUpResponseSchema = z.object({
  token: z.null().optional(),
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullish(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  }),
});
type SignUpUser = z.infer<typeof SignUpResponseSchema>["user"];

// New, duplicate and race-lost sign-ups all answer with exactly these keys:
// BetterAuth's synthetic duplicate user and a real row differ in optional fields.
function canonicalSignUpUser(user: SignUpUser) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: false,
    image: user.image ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/** The trimmed display name, or an APIError naming what is wrong with it. */
export function parseDisplayName(raw: unknown): string {
  const parsed = DisplayNameSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new APIError("BAD_REQUEST", {
    code: "NAME_INVALID",
    message: parsed.error.issues[0]?.message ?? "Check your name.",
  });
}

/**
 * Request-shape rules for the core credential flows:
 * - `name` on sign-up and profile update is a safe display name, trimmed.
 * - Only email-verification codes can be requested over HTTP.
 * - Every sign-up answer has one shape, including one that loses the
 *   `User.email` unique race, so none reveals that the address exists.
 */
export const corePolicy = {
  id: "core-auth-policy",
  hooks: {
    before: [
      {
        matcher: (ctx) => NAME_PATHS.has(ctx.path ?? ""),
        handler: createAuthMiddleware(async (ctx) => {
          const body = BodySchema.safeParse(ctx.body);
          const fields = body.success ? body.data : {};
          // update-user may leave the name untouched; sign-up always sets one.
          if (!("name" in fields) && ctx.path === "/update-user") return;
          const name = parseDisplayName(fields.name);
          return { context: { body: { ...fields, name } } };
        }),
      },
      {
        matcher: (ctx) => ctx.path === "/email-otp/send-verification-otp",
        handler: createAuthMiddleware(async (ctx) => {
          const type = z
            .object({ type: z.literal("email-verification") })
            .safeParse(ctx.body);
          if (!type.success) {
            throw new APIError("BAD_REQUEST", {
              code: "INVALID_OTP_TYPE",
              message: "Only email verification codes can be requested.",
            });
          }
        }),
      },
    ],
    after: [
      {
        matcher: (ctx) => ctx.path === "/sign-up/email",
        handler: createAuthMiddleware(async (ctx) => {
          const returned = ctx.context.returned;
          const created = SignUpResponseSchema.safeParse(returned);
          if (created.success) {
            return ctx.json({
              token: null,
              user: canonicalSignUpUser(created.data.user),
            });
          }
          if (
            !isAPIError(returned) ||
            returned.body?.code !== "FAILED_TO_CREATE_USER"
          ) {
            return;
          }
          const body = SignUpBodySchema.safeParse(ctx.body);
          if (!body.success) return;
          const email = body.data.email.toLowerCase();
          const existing =
            await ctx.context.internalAdapter.findUserByEmail(email);
          if (!existing) return;
          const now = new Date();
          // A Response, because a JSON return keeps the endpoint's 422 status.
          return Response.json({
            token: null,
            user: canonicalSignUpUser({
              id: ctx.context.generateId({ model: "user" }) || randomUUID(),
              name: body.data.name,
              email,
              image: null,
              createdAt: now,
              updatedAt: now,
            }),
          });
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;
