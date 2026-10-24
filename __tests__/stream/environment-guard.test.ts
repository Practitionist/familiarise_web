import {
  PRODUCTION_STREAM_API_KEY,
  StreamEnvironmentError,
  assertStreamKeyAllowedHere,
} from "@/lib/stream/environment-guard";
import { scriptClientOptions } from "../../scripts/stream/target";

const DEV_KEY = "dev-app-key";

const NETLIFY_PREVIEW = { NETLIFY: "true", CONTEXT: "deploy-preview" };
const NETLIFY_PRODUCTION = { NETLIFY: "true", CONTEXT: "production" };
const VERCEL_PREVIEW = { VERCEL: "1", VERCEL_ENV: "preview" };
const VERCEL_PRODUCTION = { VERCEL: "1", VERCEL_ENV: "production" };
const LOCAL = { NODE_ENV: "development" };
const CONTAINER_PRODUCTION = { NEXT_PUBLIC_SENTRY_ENVIRONMENT: "production" };

function env(vars: Record<string, string>): NodeJS.ProcessEnv {
  return { ...vars } as NodeJS.ProcessEnv;
}

describe("Stream environment guard", () => {
  it.each([
    ["a Netlify deploy preview", NETLIFY_PREVIEW],
    ["a Vercel preview", VERCEL_PREVIEW],
    ["local development", LOCAL],
  ])("refuses the production key on %s", (_name, vars) => {
    expect(() =>
      assertStreamKeyAllowedHere(
        PRODUCTION_STREAM_API_KEY,
        undefined,
        env(vars),
      ),
    ).toThrow(StreamEnvironmentError);
  });

  it.each([
    ["Netlify production", NETLIFY_PRODUCTION],
    ["Vercel production", VERCEL_PRODUCTION],
    ["a container host marked production", CONTAINER_PRODUCTION],
  ])("allows the production key on %s", (_name, vars) => {
    expect(() =>
      assertStreamKeyAllowedHere(
        PRODUCTION_STREAM_API_KEY,
        undefined,
        env(vars),
      ),
    ).not.toThrow();
  });

  it.each([NETLIFY_PREVIEW, NETLIFY_PRODUCTION, VERCEL_PREVIEW, LOCAL])(
    "allows the dev key everywhere (%o)",
    (vars) => {
      expect(() =>
        assertStreamKeyAllowedHere(DEV_KEY, undefined, env(vars)),
      ).not.toThrow();
    },
  );

  it("allows the production key for a script invoked with --target=production only", () => {
    const options = scriptClientOptions(["--apply", "--target=production"]);
    expect(() =>
      assertStreamKeyAllowedHere(
        PRODUCTION_STREAM_API_KEY,
        options,
        env(LOCAL),
      ),
    ).not.toThrow();
    expect(() =>
      assertStreamKeyAllowedHere(
        PRODUCTION_STREAM_API_KEY,
        scriptClientOptions(["--apply"]),
        env(LOCAL),
      ),
    ).toThrow(StreamEnvironmentError);
  });

  it("checks lazily: importing the module with the production key configured does not throw", async () => {
    const saved = process.env.NEXT_PUBLIC_STREAM_API_KEY;
    process.env.NEXT_PUBLIC_STREAM_API_KEY = PRODUCTION_STREAM_API_KEY;
    try {
      await expect(
        import("@/lib/stream/environment-guard"),
      ).resolves.toBeDefined();
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_STREAM_API_KEY;
      else process.env.NEXT_PUBLIC_STREAM_API_KEY = saved;
    }
  });
});
