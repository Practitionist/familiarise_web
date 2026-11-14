/**
 * Projects a full row through a Prisma `select` / `include` tree, so a mocked
 * reader returns only what its real query asks for. A test of a reader and its
 * mapper then fails when the mapper reads a field the reader never selected.
 * Relation `where` and `_count` honour plain equality and `in`; other operators
 * pass every row.
 */

type Tree = Record<string, unknown>;

const isRelation = (v: unknown): boolean =>
  Array.isArray(v) ||
  (typeof v === "object" && v !== null && !(v instanceof Date));

function matches(row: Tree, where: unknown): boolean {
  if (!where || typeof where !== "object") return true;
  return Object.entries(where as Tree).every(([key, cond]) => {
    if (cond === null || typeof cond !== "object" || cond instanceof Date) {
      return row[key] === cond;
    }
    const ops = cond as Tree;
    if (Array.isArray(ops.in)) return ops.in.includes(row[key]);
    return true;
  });
}

function countOf(row: Tree, spec: unknown): Tree {
  const select = ((spec as Tree)?.select ?? {}) as Tree;
  const out: Tree = {};
  for (const [key, inner] of Object.entries(select)) {
    const rows = Array.isArray(row[key]) ? (row[key] as Tree[]) : [];
    const where = inner === true ? undefined : (inner as Tree).where;
    out[key] = rows.filter((r) => matches(r, where)).length;
  }
  return out;
}

function projectOne(row: Tree, args: Tree): Tree {
  const select = args.select as Tree | undefined;
  const include = args.include as Tree | undefined;
  const out: Tree = {};
  if (select) {
    for (const [key, spec] of Object.entries(select)) {
      if (!spec) continue;
      if (key === "_count") {
        out[key] = countOf(row, spec);
        continue;
      }
      if (!(key in row)) continue;
      out[key] =
        spec === true ? row[key] : projectValue(row[key], spec as Tree);
    }
    return out;
  }
  for (const [key, value] of Object.entries(row)) {
    if (!isRelation(value)) out[key] = value;
  }
  for (const [key, spec] of Object.entries(include ?? {})) {
    if (!spec) continue;
    if (key === "_count") {
      out[key] = countOf(row, spec);
      continue;
    }
    if (!(key in row)) continue;
    out[key] = spec === true ? row[key] : projectValue(row[key], spec as Tree);
  }
  return out;
}

function projectValue(value: unknown, args: Tree): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((v) => matches(v as Tree, args.where))
      .map((v) => projectOne(v as Tree, args));
  }
  if (value === null || value === undefined) return value;
  return projectOne(value as Tree, args);
}

/** The row as the query `args` (`{ select }` or `{ include }`) would return it. */
export function projectRow<T>(row: Tree, args: Tree): T {
  return projectOne(row, args) as T;
}
