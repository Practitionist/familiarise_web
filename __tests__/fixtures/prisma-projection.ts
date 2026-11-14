/**
 * Projects a full row through a Prisma `select` / `include` tree, so a mocked
 * reader returns only what its real query asks for. A test of a reader and its
 * mapper then fails when the mapper reads a field the reader never selected.
 */

type Tree = Record<string, unknown>;

const isRelation = (v: unknown): boolean =>
  Array.isArray(v) ||
  (typeof v === "object" && v !== null && !(v instanceof Date));

function projectOne(row: Tree, args: Tree): Tree {
  const select = args.select as Tree | undefined;
  const include = args.include as Tree | undefined;
  const out: Tree = {};
  if (select) {
    for (const [key, spec] of Object.entries(select)) {
      if (!spec || key === "_count") continue;
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
    if (!spec || key === "_count" || !(key in row)) continue;
    out[key] = spec === true ? row[key] : projectValue(row[key], spec as Tree);
  }
  return out;
}

function projectValue(value: unknown, args: Tree): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => projectOne(v as Tree, args));
  }
  if (value === null || value === undefined) return value;
  return projectOne(value as Tree, args);
}

/** The row as the query `args` (`{ select }` or `{ include }`) would return it. */
export function projectRow<T>(row: Tree, args: Tree): T {
  return projectOne(row, args) as T;
}
