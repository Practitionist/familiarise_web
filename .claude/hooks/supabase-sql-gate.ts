/**
 * Claude Code PreToolUse hook for the Supabase MCP `execute_sql` tool.
 *
 * One Supabase project serves dev and prod, so every query is a production
 * query. A batch whose every statement is provably read-only runs without a
 * prompt; anything else (or anything this lexer cannot parse) needs the
 * owner's approval. Runs under Node's type stripping: no runtime TS syntax.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

export type SqlClassification =
  { readOnly: true; statements: number } | { readOnly: false; reason: string };

export type HookDecision = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "ask" | "deny";
    permissionDecisionReason: string;
  };
};

const READ_STARTERS = new Set(["select", "with", "show"]);

// Inside a SELECT/WITH these are the only keywords that write: data-modifying
// CTEs and SELECT … INTO. Every other write statement fails READ_STARTERS.
const WRITE_WORDS = new Set(["insert", "update", "delete", "merge", "into"]);

const MUTATING_FUNCTIONS =
  /^(setval|nextval|set_config|pg_terminate_backend|pg_cancel_backend|pg_notify|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_promote|pg_create_restore_point|lo_\w+|dblink\w*|pg_advisory\w*|pg_try_advisory\w*|pg_stat_reset\w*|pg_create_\w*replication_slot|pg_drop_replication_slot|http\w*)$/;

/**
 * Replace comments, string literals, quoted identifiers and dollar-quoted
 * bodies with neutral placeholders so keyword checks see only SQL structure.
 * Returns null on an unterminated literal or comment.
 */
export function stripSql(sql: string): string | null {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      out += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) return null;
      out += " ";
      continue;
    }
    if (c === "'") {
      const escapes =
        /[eE]/.test(sql[i - 1] ?? "") && !/\w/.test(sql[i - 2] ?? "");
      i++;
      let closed = false;
      while (i < sql.length) {
        if (escapes && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) return null;
      out += "''";
      continue;
    }
    if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end === -1) return null;
      i = end + 1;
      out += " quoted_ident ";
      continue;
    }
    if (c === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag && !/\w/.test(sql[i - 1] ?? "")) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end === -1) return null;
        i = end + tag[0].length;
        out += "''";
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

function classifyStatement(statement: string): string | null {
  let text = statement.toLowerCase().replace(/\s+/g, " ").trim();
  // EXPLAIN ANALYZE executes its statement, so classify what it wraps.
  const explain =
    /^explain\s*(\([^)]*\)\s*)?((analyze|analyse|verbose)\s+)*/.exec(text);
  if (explain) text = text.slice(explain[0].length);
  const first = /^\(*\s*([a-z_]+)/.exec(text)?.[1] ?? "";
  if (!READ_STARTERS.has(first)) {
    const kind = first ? first.toUpperCase() : "unparsed statement";
    return explain ? `EXPLAIN ${kind}` : kind;
  }
  if (/\bfor (no key |key )?(update|share)\b/.test(text))
    return "row lock (FOR UPDATE/SHARE)";
  const words = text.match(/[a-z_][a-z0-9_$]*/g) ?? [];
  const write = words.find((w) => WRITE_WORDS.has(w));
  if (write === "into") return "SELECT … INTO";
  if (write) {
    return first === "with"
      ? `data-modifying CTE (${write.toUpperCase()})`
      : write.toUpperCase();
  }
  for (const call of text.matchAll(/([a-z_][a-z0-9_$]*)\s*\(/g)) {
    if (MUTATING_FUNCTIONS.test(call[1]))
      return `mutating function ${call[1]}()`;
  }
  // Extension schemas (pg_net, pg_cron, vault, …) expose side-effecting calls.
  const qualified = /([a-z_][a-z0-9_$]*)\s*\.\s*[a-z_][a-z0-9_$]*\s*\(/.exec(
    text,
  );
  if (qualified && qualified[1] !== "pg_catalog") {
    return `schema-qualified call ${qualified[1]}.…()`;
  }
  return null;
}

/** Read-only only when every statement in the batch is provably a read. */
export function classifySql(sql: unknown): SqlClassification {
  if (typeof sql !== "string" || sql.trim() === "") {
    return { readOnly: false, reason: "empty or missing query" };
  }
  const stripped = stripSql(sql);
  if (stripped === null) {
    return {
      readOnly: false,
      reason: "unparseable SQL (unterminated string or comment)",
    };
  }
  const statements = stripped.split(";").filter((s) => s.trim() !== "");
  if (statements.length === 0)
    return { readOnly: false, reason: "no SQL statement" };
  const writes = statements
    .map(classifyStatement)
    .filter((w): w is string => w !== null);
  if (writes.length > 0)
    return { readOnly: false, reason: [...new Set(writes)].join(", ") };
  return { readOnly: true, statements: statements.length };
}

const HookInput = z.object({
  permission_mode: z.string().optional(),
  tool_input: z.object({ query: z.unknown() }),
});

/**
 * The hook's answer. `ask` is not documented to prompt under bypassPermissions,
 * so that mode gets `deny`, which blocks in every mode.
 */
export function decide(input: unknown): HookDecision {
  const payload = HookInput.safeParse(input);
  const verdict: SqlClassification = payload.success
    ? classifySql(payload.data.tool_input.query)
    : { readOnly: false, reason: "unreadable hook input" };
  const answer = (
    permissionDecision: "allow" | "ask" | "deny",
    permissionDecisionReason: string,
  ): HookDecision => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason,
    },
  });
  if (verdict.readOnly) {
    return answer(
      "allow",
      `Read-only batch of ${verdict.statements} statement(s).`,
    );
  }
  const what = `Supabase execute_sql: ${verdict.reason}. This runs against the shared dev+prod database.`;
  if (payload.success && payload.data.permission_mode === "bypassPermissions") {
    return answer(
      "deny",
      `${what} Blocked in bypass-permissions mode. Show the owner the exact statement in chat and wait; once they approve, they press Shift+Tab to leave bypass mode and you re-run it so the approval prompt appears.`,
    );
  }
  return answer("ask", `${what} Approve only if you have read the statement.`);
}

if (process.argv[1]?.endsWith("supabase-sql-gate.ts")) {
  let input: unknown = null;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    input = null;
  }
  process.stdout.write(JSON.stringify(decide(input)));
}
