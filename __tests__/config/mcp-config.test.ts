/**
 * @jest-environment node
 */

/**
 * The tracked MCP examples are reviewed security config: every package is
 * pinned, Supabase stays read-only, and Razorpay stays opt-in.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const stdioServerSchema = z
  .object({
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const httpServerSchema = z
  .object({
    type: z.literal("http"),
    url: z.string().url(),
  })
  .strict();

const serverSchema = z.union([stdioServerSchema, httpServerSchema]);
const configSchema = z.object({
  mcpServers: z.record(z.string(), serverSchema),
});

type Config = z.infer<typeof configSchema>;
type StdioServer = z.infer<typeof stdioServerSchema>;

const ROOT = process.cwd();

function load(relativePath: string): Config {
  const absolutePath = join(ROOT, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`missing config: ${relativePath}`);
  }
  const raw: unknown = JSON.parse(readFileSync(absolutePath, "utf8"));
  return configSchema.parse(raw);
}

function isStdio(server: z.infer<typeof serverSchema>): server is StdioServer {
  return "command" in server;
}

function stdio(config: Config, name: string): StdioServer {
  const server = config.mcpServers[name];
  if (!server || !isStdio(server)) {
    throw new Error(`${name} must be a stdio server`);
  }
  return server;
}

function valuesAfter(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) =>
    arg === flag && args[index + 1] ? [args[index + 1]] : [],
  );
}

const EXACT_SEMVER =
  /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/i;

function packageSpecs(args: string[]): string[] {
  const specs: string[] = [];
  let sawPackage = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-p" || arg === "--package") {
      const spec = args[index + 1];
      if (spec) specs.push(spec);
      sawPackage = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (!sawPackage) {
      specs.push(arg);
      sawPackage = true;
    }
  }
  return specs;
}

const DEFAULT = load(".mcp.json.example");
const RAZORPAY = load(".mcp.razorpay.example.json");

const CONFIGS: Array<[string, Config]> = [
  [".mcp.json.example", DEFAULT],
  [".mcp.razorpay.example.json", RAZORPAY],
];

describe(".mcp.json.example", () => {
  it("lists exactly the reviewed server set", () => {
    expect(Object.keys(DEFAULT.mcpServers).sort()).toEqual([
      "betterstack",
      "chrome-devtools",
      "netlify",
      "sentry",
      "serena",
      "streamio",
      "supabase",
    ]);
  });

  it("has no Stripe server or Stripe-only flags", () => {
    const serialized = JSON.stringify(DEFAULT);
    expect(DEFAULT.mcpServers).not.toHaveProperty("stripe");
    expect(serialized).not.toContain("@stripe/mcp");
    expect(serialized).not.toContain("--tools=all");
  });

  it("keeps Razorpay out of the default config", () => {
    const serialized = JSON.stringify(DEFAULT);
    expect(DEFAULT.mcpServers).not.toHaveProperty("rzp-mcp-server");
    expect(serialized).not.toContain("mcp.razorpay.com");
    expect(serialized).not.toContain("mcp-remote");
  });

  it("runs Supabase read-only against the expected project", () => {
    const supabase = stdio(DEFAULT, "supabase");
    expect(supabase.args.filter((arg) => arg === "--read-only")).toHaveLength(
      1,
    );
    expect(supabase.args.filter((arg) => arg === "--project-ref")).toHaveLength(
      1,
    );
    expect(valuesAfter(supabase.args, "--project-ref")).toEqual([
      "pzmbxqdgibfkhjwzeprf",
    ]);
    expect(supabase.args).not.toContain("--read-write");
  });

  it("pins the Supabase peer triple exactly", () => {
    const supabase = stdio(DEFAULT, "supabase");
    expect(valuesAfter(supabase.args, "-p")).toEqual([
      "@modelcontextprotocol/sdk@1.32.1",
      "zod@3.25.76",
      "@supabase/mcp-server-supabase@0.8.1",
    ]);
    expect(supabase.args).toContain("mcp-server-supabase");
    expect(supabase.env?.SUPABASE_ACCESS_TOKEN).toBe("<SUPABASE_ACCESS_TOKEN>");
  });

  it("pins every npx package to an exact semver", () => {
    const unpinned: string[] = [];

    for (const [file, config] of CONFIGS) {
      for (const [name, server] of Object.entries(config.mcpServers)) {
        if (!isStdio(server) || server.command !== "npx") continue;

        const specs = packageSpecs(server.args);
        if (specs.length === 0) {
          unpinned.push(`${file}: ${name} has no package spec`);
        }
        for (const spec of specs) {
          if (!EXACT_SEMVER.test(spec) || /@latest|[\^~*]/.test(spec)) {
            unpinned.push(`${file}: ${name} -> ${spec}`);
          }
        }
      }
    }

    expect(unpinned).toEqual([]);
  });

  it("uses Serena's v2.1.0 entry point", () => {
    const serena = stdio(DEFAULT, "serena");
    expect(serena.command).toBe("uvx");
    expect(valuesAfter(serena.args, "--from")).toEqual([
      "git+https://github.com/oraios/serena@v2.1.0",
    ]);
    expect(serena.args).toContain("serena");
    expect(serena.args).toContain("start-mcp-server");
    expect(valuesAfter(serena.args, "--context")).toEqual(["claude-code"]);
    expect(serena.args).toContain("--project-from-cwd");
    expect(serena.args).not.toContain("serena-mcp-server");
  });

  it("keeps Stream read-only and exposes remotes only over HTTP", () => {
    const streamio = stdio(DEFAULT, "streamio");
    expect(streamio.env?.STREAM_MCP_READ_ONLY).toBe("true");

    for (const server of Object.values(DEFAULT.mcpServers)) {
      if (isStdio(server)) continue;
      expect(server.type).toBe("http");
      expect(server.url).toMatch(/^https:\/\//);
      expect(server).not.toHaveProperty("command");
      expect(server).not.toHaveProperty("args");
    }
  });
});

describe(".mcp.razorpay.example.json", () => {
  it("ships exactly one opt-in server", () => {
    expect(Object.keys(RAZORPAY.mcpServers)).toEqual(["rzp-mcp-server"]);
  });

  it("is pinned and targets Razorpay over HTTPS with a placeholder header", () => {
    const razorpay = stdio(RAZORPAY, "rzp-mcp-server");
    expect(packageSpecs(razorpay.args)).toContain("mcp-remote@0.15.2");
    expect(razorpay.args).toContain("https://mcp.razorpay.com/mcp");

    const headers = valuesAfter(razorpay.args, "--header");
    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatch(/^Authorization: Basic <[A-Z0-9_]+>$/);
  });

  it("contains no live secrets", () => {
    const serialized = JSON.stringify(RAZORPAY);
    expect(serialized).not.toMatch(/sk_live_|rzp_live_|whsec_/);
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
  });
});

describe(".gitignore", () => {
  it("ignores the working Razorpay sidecar", () => {
    const lines = readFileSync(join(ROOT, ".gitignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim());
    expect(lines).toContain(".mcp.razorpay.json");
  });
});

describe("server schema", () => {
  it("rejects a server that mixes stdio and HTTP keys", () => {
    const mixed = {
      command: "npx",
      args: ["pkg@1.0.0"],
      type: "http",
      url: "https://example.com",
    };
    expect(serverSchema.safeParse(mixed).success).toBe(false);
  });
});
