/**
 * CI guard for `.github/workflows/` — verifies that every `${{ secrets.NAME }}`
 * referenced by any workflow is declared in the required-secrets manifest.
 *
 * A `${{ secrets.NAME }}` that does not exist does not error in GitHub Actions;
 * it interpolates an empty string and the job reports success while running
 * without a credential. Every referenced secret name must appear in
 * docs/enterprise/50-operations/07-required-secrets.md.
 *
 * Pure static analysis: no network, no database, safe to run anywhere.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");
const MANIFEST = path.join(
  ROOT,
  "docs",
  "enterprise",
  "50-operations",
  "07-required-secrets.md",
);

const errors: string[] = [];

/** Strip `#` comments so a secret name mentioned in prose isn't read as a reference. */
function stripComments(yaml: string): string {
  return yaml
    .split("\n")
    .map((line) => {
      const hash = line.indexOf("#");
      if (hash === -1) return line;
      // Only treat `#` as a comment when it starts the token — avoids eating
      // `#709`-style issue refs that appear inside quoted strings.
      const before = line.slice(0, hash);
      const quotes = (before.match(/"/g) ?? []).length;
      return quotes % 2 === 1 ? line : before;
    })
    .join("\n");
}

const files = fs
  .readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

// Manifest rows look like `| \`SECRET_NAME\` | consumers | consequence |`, and a
// single cell may list several comma-separated names.
const manifest = fs.readFileSync(MANIFEST, "utf8");
const declared = new Set<string>();
for (const row of manifest.split("\n")) {
  if (!row.trimStart().startsWith("|")) continue;
  const firstCell = row.split("|")[1] ?? "";
  for (const m of firstCell.matchAll(/`([A-Z0-9_]+)`/g)) declared.add(m[1]);
}
if (declared.size === 0) {
  errors.push(
    `manifest parse failure: no secret names found in ${path.relative(ROOT, MANIFEST)}`,
  );
}

const referencedBy = new Map<string, string[]>();
for (const file of files) {
  const body = stripComments(
    fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8"),
  );
  for (const m of body.matchAll(/secrets\.([A-Z0-9_]+)/g)) {
    const list = referencedBy.get(m[1]) ?? [];
    if (!list.includes(file)) list.push(file);
    referencedBy.set(m[1], list);
  }
}

for (const [secret, workflows] of Array.from(referencedBy).sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  // GITHUB_TOKEN is injected by Actions itself and is never a repo secret.
  if (secret === "GITHUB_TOKEN") continue;
  if (!declared.has(secret)) {
    errors.push(
      `undeclared secret \`${secret}\` referenced by ${workflows.join(", ")} — ` +
        `add a row to ${path.relative(ROOT, MANIFEST)} stating what breaks without it`,
    );
  }
}

if (errors.length > 0) {
  console.error("check-workflow-hygiene: FAILED\n");
  for (const e of errors) console.error(`  - ${e}`);
  console.error(
    `\n${errors.length} problem(s) across ${files.length} workflow files.`,
  );
  process.exit(1);
}

console.log(
  `check-workflow-hygiene: ok (${files.length} workflows, ${referencedBy.size} distinct secrets verified)`,
);
