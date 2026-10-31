/** @jest-environment node */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { TARGETS } from "../../lib/cron/schedule";

const ROOT = path.resolve(__dirname, "../..");
const REGISTRY = "lib/cron/cleanup-registry.ts";
const PREDICATE = /(Where|WHERE)$/;

const sources = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  let parsed = sources.get(file);
  if (!parsed) {
    parsed = ts.createSourceFile(
      file,
      fs.readFileSync(path.join(ROOT, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    sources.set(file, parsed);
  }
  return parsed;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function nameOf(node: ts.Node | undefined): string | undefined {
  return node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node))
    ? node.text
    : undefined;
}

function prop(
  node: ts.Node | undefined,
  key: string,
): ts.Expression | undefined {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  for (const member of node.properties) {
    if (ts.isPropertyAssignment(member) && nameOf(member.name) === key) {
      return member.initializer;
    }
  }
  return undefined;
}

function resolve(from: string, spec: string): string {
  const base = spec.startsWith("@/")
    ? spec.slice(2)
    : path.join(path.dirname(from), spec);
  const file = [base, `${base}.ts`, `${base}.mts`, `${base}/index.ts`].find(
    (candidate) =>
      fs.existsSync(path.join(ROOT, candidate)) && candidate !== base,
  );
  if (!file) throw new Error(`Cannot resolve ${spec} from ${from}`);
  return file;
}

/** The modules and bindings a registry entry property imports dynamically. */
function dynamicImports(node: ts.Node): { file: string; names: string[] }[] {
  const found: { file: string; names: string[] }[] = [];
  walk(node, (child) => {
    if (!ts.isVariableDeclaration(child) || !child.initializer) return;
    const value = ts.isAwaitExpression(child.initializer)
      ? child.initializer.expression
      : child.initializer;
    if (
      !ts.isCallExpression(value) ||
      value.expression.kind !== ts.SyntaxKind.ImportKeyword
    )
      return;
    const spec = nameOf(value.arguments[0]);
    if (!spec || !ts.isObjectBindingPattern(child.name)) return;
    found.push({
      file: resolve(REGISTRY, spec),
      names: child.name.elements.flatMap(
        (element) => nameOf(element.propertyName ?? element.name) ?? [],
      ),
    });
  });
  return found;
}

/** The declaration of an exported function, following one re-export hop. */
function declaration(
  file: string,
  name: string,
): { file: string; node: ts.Node } {
  let found: ts.Node | undefined;
  let reexport: string | undefined;
  walk(parse(file), (node) => {
    if (ts.isFunctionDeclaration(node) && nameOf(node.name) === name) {
      found = node;
    }
    if (
      ts.isVariableDeclaration(node) &&
      nameOf(node.name) === name &&
      node.initializer
    ) {
      found = node.initializer;
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause) &&
      node.exportClause.elements.some((e) => e.name.text === name)
    ) {
      reexport = nameOf(node.moduleSpecifier);
    }
  });
  if (found) return { file, node: found };
  if (reexport) return declaration(resolve(file, reexport), name);
  throw new Error(`${name} is not declared in ${file}`);
}

/** A probe's `where` may only combine named predicate builders. */
function composedOfBuilders(expr: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expr))
    return composedOfBuilders(expr.expression);
  if (ts.isIdentifier(expr)) return PREDICATE.test(expr.text);
  if (ts.isCallExpression(expr))
    return PREDICATE.test(nameOf(expr.expression) ?? "");
  if (ts.isObjectLiteralExpression(expr)) {
    return expr.properties.every((member) => {
      if (ts.isSpreadAssignment(member))
        return composedOfBuilders(member.expression);
      if (!ts.isPropertyAssignment(member)) return false;
      const key = nameOf(member.name);
      return (
        (key === "OR" || key === "AND") &&
        ts.isArrayLiteralExpression(member.initializer) &&
        member.initializer.elements.every(composedOfBuilders)
      );
    });
  }
  return false;
}

/** Whether `name` is read in `file` outside its own declaration, imports and the given span. */
function usedOutside(file: string, name: string, span?: number[]): boolean {
  const source = parse(file);
  let used = false;
  walk(source, (node) => {
    if (!ts.isIdentifier(node) || node.text !== name) return;
    if (span && node.getStart(source) >= span[0] && node.getEnd() <= span[1])
      return;
    const parent = node.parent;
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return;
    if (
      (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)) &&
      parent.name === node
    )
      return;
    used = true;
  });
  return used;
}

/** The module a file imports `name` from, if it does. */
function importedFrom(file: string, name: string): string | undefined {
  for (const statement of parse(file).statements) {
    if (
      ts.isImportDeclaration(statement) &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (e) => e.name.text === name,
      )
    ) {
      const spec = nameOf(statement.moduleSpecifier);
      return spec ? resolve(file, spec) : undefined;
    }
  }
  return undefined;
}

interface Probe {
  slug: string;
  probe: string;
  file: string;
  buildFiles: string[];
}

function registryProbes(): { probes: Probe[]; declared: string[] } {
  const probes: Probe[] = [];
  const declared: string[] = [];
  walk(parse(REGISTRY), (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      nameOf(node.name) !== "CLEANUP_JOB_BUILDERS" ||
      !node.initializer ||
      !ts.isObjectLiteralExpression(node.initializer)
    )
      return;
    for (const member of node.initializer.properties) {
      if (!ts.isPropertyAssignment(member)) continue;
      const slug = nameOf(member.name) ?? "";
      const idle = prop(member.initializer, "idle");
      if (prop(idle, "alwaysRun") || prop(idle, "hasWork")) declared.push(slug);
      const hasWork = prop(idle, "hasWork");
      if (!hasWork) continue;
      const [imported] = dynamicImports(hasWork);
      const build = prop(member.initializer, "build");
      probes.push({
        slug,
        probe: imported.names[0],
        file: imported.file,
        buildFiles: build
          ? dynamicImports(build)
              .map((i) => i.file)
              .filter((file) => !file.startsWith("lib/cron/"))
          : [],
      });
    }
  });
  return { probes, declared };
}

const { probes, declared } = registryProbes();

describe("ticker idle probes", () => {
  it("declares a probe or an always-run reason for every ticker target", () => {
    expect([...declared].sort()).toEqual([...TARGETS].sort());
  });

  it.each(probes.map((p) => [p.slug, p] as const))(
    "%s probes with the same predicates its claim query reads",
    (_slug, p) => {
      // A background target's build only dispatches; every other probe lives with its claim.
      expect(p.buildFiles.length === 0 || p.buildFiles.includes(p.file)).toBe(
        true,
      );
      const probe = declaration(p.file, p.probe);
      const source = parse(probe.file);
      const span = [probe.node.getStart(source), probe.node.getEnd()];
      const builders = new Set<string>();
      const inlineWheres: string[] = [];
      // A probe-local helper is checked through the shared builders it calls.
      const locals = new Set<string>();
      walk(probe.node, (node) => {
        if (ts.isIdentifier(node) && PREDICATE.test(node.text)) {
          builders.add(node.text);
        }
        if (ts.isVariableDeclaration(node)) locals.add(nameOf(node.name) ?? "");
        if (
          ts.isPropertyAssignment(node) &&
          nameOf(node.name) === "where" &&
          !composedOfBuilders(node.initializer)
        ) {
          inlineWheres.push(node.initializer.getText(source));
        }
      });
      expect(inlineWheres).toEqual([]);
      expect(builders.size).toBeGreaterThan(0);
      for (const builder of [...builders].filter((b) => !locals.has(b))) {
        const definedIn = importedFrom(probe.file, builder);
        const used =
          usedOutside(probe.file, builder, span) ||
          (definedIn !== undefined && usedOutside(definedIn, builder));
        expect([builder, used]).toEqual([builder, true]);
      }
    },
  );
});
