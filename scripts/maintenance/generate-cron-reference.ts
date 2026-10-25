/** Generates the operational inventory without importing worker or registry modules. */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { JOB_SCHEDULES, MAX_TARGETS_PER_TICK } from "../../lib/cron/schedule";
import { FINANCIAL_JOB_NAMES } from "../../lib/cron/financial-jobs";
import { MANUAL_ONLY } from "../../lib/cron/manual-only";

const ROOT = path.resolve(__dirname, "../..");
const OUTPUT = "docs/maintenance/04-cron-jobs-reference.md";
const REGISTRY = "lib/cron/cleanup-registry.ts";
const FLEET_WORKFLOWS = [
  "cron-daily.yml",
  "cron-intra-day.yml",
  "cron-weekly.yml",
];

type Core = { file: string; calls: string[] };
type RegistryJob = {
  slug: string;
  job: string;
  line: number;
  cores: Core[];
  node: ts.Node;
};
type WorkflowJob = {
  id: string;
  name: string;
  file: string;
  core?: string;
  slug?: string;
  crons: string[];
  timeout?: string;
};
type Lease = { name: string; mode: string; ttl: string; file: string };

function tree(source: string, file: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
}

function descendants(node: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  function visit(child: ts.Node) {
    out.push(child);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return out;
}

function unwrap(node: ts.Expression): ts.Expression {
  return ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
    ? unwrap(node.expression)
    : node;
}

function text(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteralLike(node) || ts.isIdentifier(node))
    ? node.text
    : undefined;
}

function property(
  node: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  const member = node.properties.find(
    (item) => ts.isPropertyAssignment(item) && text(item.name) === name,
  );
  return member && ts.isPropertyAssignment(member)
    ? member.initializer
    : undefined;
}

function resolveModule(
  from: string,
  spec: string,
  root: string,
): string | undefined {
  if (!spec.startsWith("@/") && !spec.startsWith(".")) return undefined;
  const relative = spec.startsWith("@/")
    ? spec.slice(2)
    : path.join(path.dirname(from), spec);
  return [
    relative,
    `${relative}.ts`,
    `${relative}.mts`,
    `${relative}.tsx`,
    `${relative}/index.ts`,
  ].find(
    (candidate) =>
      fs.existsSync(path.join(root, candidate)) &&
      fs.statSync(path.join(root, candidate)).isFile(),
  );
}

function importedCores(
  initializer: ts.Node,
  root: string,
  from = REGISTRY,
): Core[] {
  const cores: Core[] = [];
  for (const node of descendants(initializer)) {
    if (!ts.isVariableDeclaration(node) || !node.initializer) continue;
    const value = ts.isAwaitExpression(node.initializer)
      ? node.initializer.expression
      : node.initializer;
    if (
      !ts.isCallExpression(value) ||
      value.expression.kind !== ts.SyntaxKind.ImportKeyword
    )
      continue;
    const spec = text(value.arguments[0]);
    const target = resolveModule(from, spec ?? "", root);
    if (
      !target ||
      /^(lib\/(cron|observability)\/|lib\/prisma\.ts$)/.test(target)
    )
      continue;
    const calls = ts.isObjectBindingPattern(node.name)
      ? node.name.elements
          .map((binding) => text(binding.propertyName ?? binding.name))
          .filter((name): name is string => !!name)
      : [text(node.name)].filter((name): name is string => !!name);
    cores.push({ file: target, calls });
  }
  return cores;
}

/** Builder keys are executable AST properties; marker comments never become inventory rows. */
export function registryJobs(source: string, root: string): RegistryJob[] {
  const file = tree(source, REGISTRY);
  const declaration = descendants(file).find(
    (node) =>
      ts.isVariableDeclaration(node) &&
      text(node.name) === "CLEANUP_JOB_BUILDERS",
  );
  const object =
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer
      ? unwrap(declaration.initializer)
      : undefined;
  if (!object || !ts.isObjectLiteralExpression(object))
    throw new Error("Cannot read CLEANUP_JOB_BUILDERS object");
  return object.properties.map((member) => {
    if (!ts.isPropertyAssignment(member))
      throw new Error("Unsupported registry member");
    const slug = text(member.name);
    const route = descendants(member.initializer).find(
      (node) =>
        ts.isCallExpression(node) && text(node.expression) === "cleanupRoute",
    );
    const options =
      route && ts.isCallExpression(route) ? route.arguments[0] : undefined;
    const job =
      options && ts.isObjectLiteralExpression(options)
        ? text(property(options, "job"))
        : undefined;
    if (!slug || !job)
      throw new Error(
        `Missing literal builder key/job at ${member.getStart(file)}`,
      );
    return {
      slug,
      job,
      line: file.getLineAndCharacterOfPosition(member.getStart(file)).line + 1,
      cores: importedCores(member.initializer, root),
      node: member.initializer,
    };
  });
}

/** Fleet steps currently use literal schedule comparisons and tsx or cleanup-route commands. */
export function workflowJobs(source: string, file: string): WorkflowJob[] {
  return source.split(/(?=^ {6}- name:)/m).flatMap((block) => {
    const id = /^ {8}id:\s*([a-z0-9-]+)\s*$/m.exec(block)?.[1];
    if (!id) return [];
    const name = /^ {6}- name:([^\r\n]*)/m.exec(block)?.[1]?.trim() || id;
    const core =
      /(?:node_modules\/\.bin\/tsx|npx(?: --no-install)? tsx)\s+((?:jobs|scripts)\/[^\s"']+\.ts)/.exec(
        block,
      )?.[1];
    const slug = /\/api\/cleanup\/([a-z0-9-]+)/.exec(block)?.[1];
    if (!core && !slug)
      throw new Error(`Unsupported operational step ${file}:${id}`);
    const crons = [
      ...new Set(
        Array.from(
          block.matchAll(/github\.event\.schedule\s*==\s*'([^']+)'/g),
          (hit) => hit[1],
        ),
      ),
    ];
    return [
      {
        id,
        name,
        file,
        core,
        slug,
        crons,
        timeout: /^ {8}timeout-minutes:\s*(\d+)\s*$/m.exec(block)?.[1],
      },
    ];
  });
}

function numeric(
  node: ts.Expression,
  constants: Map<string, ts.Expression>,
): number | undefined {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isIdentifier(node)) {
    const value = constants.get(node.text);
    return value ? numeric(value, new Map()) : undefined;
  }
  if (ts.isParenthesizedExpression(node))
    return numeric(node.expression, constants);
  if (!ts.isBinaryExpression(node)) return undefined;
  const left = numeric(node.left, constants),
    right = numeric(node.right, constants);
  if (left === undefined || right === undefined) return undefined;
  switch (node.operatorToken.kind) {
    case ts.SyntaxKind.AsteriskToken:
      return left * right;
    case ts.SyntaxKind.PlusToken:
      return left + right;
    case ts.SyntaxKind.MinusToken:
      return left - right;
    case ts.SyntaxKind.SlashToken:
      return left / right;
    default:
      return undefined;
  }
}

function leaseCalls(
  node: ts.Node,
  file: string,
  constants: Map<string, ts.Expression>,
): Lease[] {
  return descendants(node).flatMap((call) => {
    if (!ts.isCallExpression(call) || text(call.expression) !== "withCronLock")
      return [];
    const name = text(call.arguments[0]),
      opts = call.arguments[1];
    if (!name || !opts || !ts.isObjectLiteralExpression(opts)) return [];
    const ttl = property(opts, "ttlMs");
    const configuredTtl = ttl ?? constants.get("DEFAULT_TTL_MS");
    const milliseconds = configuredTtl
      ? numeric(configuredTtl, constants)
      : undefined;
    let ttlLabel = ttl?.getText() ?? "default TTL unresolved";
    if (milliseconds !== undefined) {
      ttlLabel = `${milliseconds / 60000} min${ttl ? "" : " (default)"}`;
    }
    return [
      {
        name,
        mode: text(property(opts, "failMode")) ?? "unresolved",
        ttl: ttlLabel,
        file,
      },
    ];
  });
}

function humanize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .replace(/^./, (first) => first.toUpperCase());
}

function code(value: string): string {
  const escaped = value.replace(/\|/g, String.raw`\|`);
  return `\`${escaped}\``;
}
function link(file: string, line?: number): string {
  const label = line ? `${file}:${line}` : file;
  const anchor = line ? `#L${line}` : "";
  return `[${label}](../../${file}${anchor})`;
}
function cell(value: string): string {
  return value.replace(/\n/g, " ").replace(/(?<!\\)\|/g, String.raw`\|`);
}
function table(headers: string[], rows: string[][]): string {
  return [headers, headers.map(() => "---"), ...rows]
    .map((row) => `| ${row.map(cell).join(" | ")} |`)
    .join("\n");
}

function matched(step: WorkflowJob, job: RegistryJob) {
  return (
    step.slug === job.slug ||
    step.id === job.slug ||
    step.id === job.job ||
    !!(step.core && job.cores.some((core) => core.file === step.core))
  );
}
function leaseLabel(found: Lease[]): string {
  return found.length
    ? found
        .map((lease) => `${code(lease.name)}; ${lease.mode}; ${lease.ttl}`)
        .join("<br>")
    : "No matching lease statically resolved; inspect core";
}
function cronLabel(step: WorkflowJob): string {
  return `${link(step.file)} (${code(step.id)}): ${step.crons.length ? step.crons.map(code).join(", ") + " UTC" : "manual / condition requires inspection"}`;
}

function importedWorkerFiles(
  parsed: ts.SourceFile,
  file: string,
  root: string,
): string[] {
  return parsed.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement)) return [];
    const spec = text(statement.moduleSpecifier);
    const target = spec ? resolveModule(file, spec, root) : undefined;
    if (
      !target ||
      !/^(scripts|jobs|lib)\//.test(target) ||
      /^lib\/(prisma|cron|observability|redis)/.test(target)
    )
      return [];
    return [target];
  });
}

export async function generateCronReference(root = ROOT): Promise<string> {
  const prettier = await import("prettier");
  const sources = new Map<string, ts.SourceFile>();
  function read(file: string) {
    let parsed = sources.get(file);
    if (!parsed) {
      parsed = tree(fs.readFileSync(path.join(root, file), "utf8"), file);
      sources.set(file, parsed);
    }
    return parsed;
  }
  const constants = new Map<string, ts.Expression>();
  for (const node of descendants(read("lib/cron/with-cron-lock.ts")))
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    )
      constants.set(node.name.text, node.initializer);
  const jobs = registryJobs(
    fs.readFileSync(path.join(root, REGISTRY), "utf8"),
    root,
  ).sort((a, b) => (a.slug < b.slug ? -1 : Number(a.slug > b.slug)));
  const workflows = FLEET_WORKFLOWS.flatMap((name) => {
    const file = `.github/workflows/${name}`;
    return workflowJobs(fs.readFileSync(path.join(root, file), "utf8"), file);
  });
  function leases(
    files: string[],
    name: string,
    inline?: ts.Node,
    strict = false,
  ): Lease[] {
    const found = inline
      ? leaseCalls(inline, REGISTRY, constants).filter(
          (lease) => lease.name === name,
        )
      : [];
    const visited = new Set<string>();
    function walk(file: string, depth: number) {
      if (visited.has(file) || depth > 2) return;
      visited.add(file);
      const parsed = read(file);
      const localConstants = new Map(constants);
      for (const declaration of descendants(parsed))
        if (
          ts.isVariableDeclaration(declaration) &&
          ts.isIdentifier(declaration.name) &&
          declaration.initializer
        )
          localConstants.set(declaration.name.text, declaration.initializer);
      const declared = leaseCalls(parsed, file, localConstants);
      const matching = declared.filter((lease) => lease.name === name);
      let local = matching;
      if (!strict && !local.length && declared.length === 1) local = declared;
      found.push(...local);
      if (local.length) return;
      for (const target of importedWorkerFiles(parsed, file, root)) {
        walk(target, depth + 1);
      }
    }
    files.forEach((file) => walk(file, 0));
    return [
      ...new Map(
        found.map((lease) => [`${lease.file}:${lease.name}`, lease]),
      ).values(),
    ];
  }
  function scheduleLabel(job: RegistryJob): string {
    const schedule = JOB_SCHEDULES.find((item) => item.name === job.slug);
    const owners = workflows
      .filter((step) => matched(step, job))
      .map(cronLabel);
    if (schedule) {
      const window = schedule.window
        ? "<br>UTC window " + code(JSON.stringify(schedule.window))
        : "";
      owners.unshift(
        `Ticker: every ${schedule.everyMinutes} min; offset ${schedule.offsetMinutes} min${window}`,
      );
    }
    if (MANUAL_ONLY[job.slug]) owners.push(`Manual: ${MANUAL_ONLY[job.slug]}`);
    return owners.join("<br>") || "No configured owner found";
  }
  const rows = jobs.map((job) => {
    const schedule = JOB_SCHEDULES.find((item) => item.name === job.slug);
    const cores = [...job.cores];
    const backgroundFile = schedule?.backgroundFunction
      ? resolveModule(
          REGISTRY,
          `@/netlify/functions/${schedule.backgroundFunction}`,
          root,
        )
      : null;
    if (schedule?.backgroundFunction && !backgroundFile)
      throw new Error(
        `Missing background entry ${schedule.backgroundFunction}`,
      );
    if (backgroundFile) {
      for (const clause of descendants(read(backgroundFile))) {
        if (ts.isCaseClause(clause) && text(clause.expression) === job.job)
          cores.push(...importedCores(clause, root, backgroundFile));
      }
    }
    const calls = [...new Set(cores.flatMap((core) => core.calls))];
    const workflowBounds = workflows
      .filter((step) => matched(step, job) && step.timeout)
      .map((step) => `${step.timeout} min Actions step timeout`);
    const coreFiles = cores.map((core) => core.file);
    if (backgroundFile) coreFiles.push(backgroundFile);
    let requestBounds =
      workflowBounds.join("; ") || "Core bounds not statically resolved";
    if (schedule) {
      const execution = schedule.backgroundFunction
        ? "; background admission only; 15 min worker ceiling"
        : "";
      requestBounds = `limit ${schedule.limit ?? "not sent"}; HTTP abort ${schedule.timeoutMs} ms${execution}`;
    }
    return [
      code(job.slug),
      calls.length
        ? calls.map(humanize).join("; ")
        : humanize(job.slug) + " (inline registry implementation)",
      coreFiles.length
        ? coreFiles.map((file) => link(file)).join("<br>")
        : link(REGISTRY, job.line),
      scheduleLabel(job),
      leaseLabel(leases(coreFiles, job.job, job.node, Boolean(backgroundFile))),
      FINANCIAL_JOB_NAMES.has(job.job)
        ? "Blocked OFFLINE and DEGRADED"
        : "Blocked OFFLINE",
      requestBounds,
    ];
  });
  const missing = workflows.filter(
    (step) => !jobs.some((job) => matched(step, job)),
  );
  const outsideTicker = jobs.filter(
    (job) => !JOB_SCHEDULES.some((schedule) => schedule.name === job.slug),
  );
  const missingRows = missing.map((step) => [
    code(step.id),
    step.name,
    step.core
      ? link(step.core)
      : `Missing cleanup route ${code(step.slug ?? "unknown")}`,
    cronLabel(step),
    step.core ? leaseLabel(leases([step.core], step.id)) : "Not resolved",
    step.timeout
      ? `${step.timeout} min Actions step timeout`
      : "Inspect workflow",
  ]);
  const output = `# Configured cron jobs reference

<!-- Generated by scripts/maintenance/generate-cron-reference.ts. Edit the executable sources, then regenerate. -->

Run \`npm run cron:reference\` to regenerate; \`npm run cron:reference:check\` fails when this file is stale. The generator reads executable registry keys and worker lease calls through the TypeScript AST, reads the three operational fleet workflows as source, and imports only the pure schedule, financial-name and manual-only catalogs. It never imports worker modules or contacts a database or vendor.

## Inventory and evidence

- **${jobs.length} registered cleanup jobs:** ${JOB_SCHEDULES.length} configured ticker targets and ${outsideTicker.length} registered jobs outside the ticker.
- **${missing.length} operational Actions steps without a registered cleanup builder**, listed separately below. Monitor/security/CI workflows are outside this operational fleet inventory.
- **Configured is not live-verified.** Every row describes repository configuration. This generation did not check deployment state, Actions enablement/budget, accepted Sentry check-ins or completed obligations. The fleet switch selects the active platform; a configured ticker target is not proof that it executed.
- **${MAX_TARGETS_PER_TICK} targets per tick is a tested wave design bound.** The resumable ledger target yields on crowded slots; other due work is not truncated. The cadence/collision tests guard the planned roster. An HTTP abort does not cancel the worker, and a lease does not deduplicate sequential external effects.

## Registered jobs

The purpose column expands imported entry function names, not a second hand-maintained policy description. Core links are statically visible worker imports; inline implementations link to their registry entry. Lease lookup follows local imports by at most two levels and reports unresolved metadata explicitly. Lease fields show configured mode/TTL, not proof of successful acquisition. Default TTL is declared in ${link("lib/cron/with-cron-lock.ts")}; maintenance admission comes from ${link("lib/cron/financial-jobs.ts")}.

${table(["Cleanup slug", "Purpose / entry function", "Core source", "Configured schedule", "Postgres lease: name; mode; TTL", "Maintenance admission", "Configured request bounds"], rows)}

## Actions steps missing registry coverage

These are configured workflow steps, not automatically available cleanup/admin jobs. Do not infer an HTTP twin or migrate a schedule from this table alone. A replacement must be bounded and verified with a controlled single-job deployment check before switching the active schedule; leases alone do not justify dual scheduling.

${table(["Workflow step", "Purpose / step name", "Core source", "Configured schedule", "Lease", "Workflow bound"], missingRows)}

## Changing a job

1. Keep one implementation and register its cleanup builder; do not add wrapper layers.
2. Update ${link("lib/cron/schedule.ts")} for ticker timing and request limits, or the owning workflow for remaining Actions jobs. Preserve one active schedule.
3. Regenerate this reference and run the schedule/collision, inventory and documentation drift tests.
4. Verify completed work and error/hold behavior in the deployed environment before treating the configuration as healthy. Record deployment evidence separately from this generated file.

## Deprecated & Superseded Approaches

Manual inventory counts, marker-comment scraping and copied schedule tables drifted from the executable roster. This file now derives builder keys, schedule values, worker imports and lease declarations from source. Generated configuration cannot replace a deployed recovery/failback check, a backlog measurement or accepted monitoring events. No additional scheduler, job-control table or worker-importing JobSpec is introduced.
`;
  return prettier.format(output, {
    ...(await prettier.resolveConfig(path.join(root, OUTPUT))),
    parser: "markdown",
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check"))
    throw new Error("Usage: generate-cron-reference.ts [--check]");
  const generated = await generateCronReference();
  const file = path.join(ROOT, OUTPUT);
  if (args.includes("--check")) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== generated) {
      console.error(`${OUTPUT} is stale; run npm run cron:reference`);
      process.exitCode = 1;
    } else console.log(`${OUTPUT} matches executable configuration`);
  } else {
    fs.writeFileSync(file, generated);
    console.log(`Generated ${OUTPUT}`);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.join(ROOT, "scripts/maintenance/generate-cron-reference.ts")
)
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
