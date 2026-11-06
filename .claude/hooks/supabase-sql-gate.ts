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

// Built-ins that write sequences, settings, WAL, slots, stats, indexes, locks
// or files. A user-defined function that writes is not detectable here.
const MUTATING_FUNCTIONS =
  /^(setval|nextval|set_config|pg_terminate_backend|pg_cancel_backend|pg_notify|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_promote|pg_create_restore_point|pg_backup_\w+|pg_(start|stop)_backup|pg_wal_replay_\w+|pg_log_backend_memory_contexts|pg_logical_emit_message|pg_logical_slot_get_\w+|pg_replication_slot_advance|pg_replication_origin_\w+|pg_(create|copy)_\w*replication_slot|pg_drop_replication_slot|pg_sync_replication_slots|pg_import_system_collations|pg_(restore|clear)_\w+_stats|pg_stat_\w*reset\w*|brin_\w*summarize\w*|gin_clean_pending_list|lo_\w+|dblink\w*|pg_advisory\w*|pg_try_advisory\w*|pg_file_\w+|http\w*)$/;

// PostgreSQL identifier characters: any non-ASCII character counts as a letter.
const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_CONT = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;
// A name in stripped text: a `"quoted"` identifier or a bare one.
const NAME = String.raw`(?:"([^"]*)"|([a-z_\u0080-￿][a-z0-9_$\u0080-￿]*))`;

/** Index just past a '…' literal opened at `start`, or -1 if unterminated. */
function skipString(sql: string, start: number, backslashEscapes: boolean) {
  let i = start + 1;
  while (i < sql.length) {
    if (backslashEscapes && sql[i] === "\\") {
      i += 2;
    } else if (sql[i] === "'") {
      if (sql[i + 1] !== "'") return i + 1;
      i += 2;
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * Tokenise like PostgreSQL's lexer and drop comments, string literals and
 * dollar-quoted bodies so keyword checks see only SQL structure. Quoted
 * identifiers keep their name, lowercased and reduced to identifier
 * characters, inside double quotes. Returns null on an unterminated literal
 * or comment, or a U&"…" identifier whose escapes could spell any name.
 */
export function stripSql(sql: string): string | null {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") i++;
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
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < sql.length && IDENT_CONT.test(sql[j])) j++;
      const word = sql.slice(i, j);
      const prefix = word.toLowerCase();
      if (prefix === "u" && sql[j] === "&" && sql[j + 1] === '"') return null;
      if (prefix === "u" && sql[j] === "&" && sql[j + 1] === "'") j++;
      if (sql[j] === "'" && ["e", "u", "b", "x", "n"].includes(prefix)) {
        const end = skipString(sql, j, prefix === "e");
        if (end === -1) return null;
        out += " '' ";
        i = end;
        continue;
      }
      out += word;
      i = j;
      continue;
    }
    if (c === "'") {
      const end = skipString(sql, i, false);
      if (end === -1) return null;
      out += " '' ";
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let name = "";
      for (;;) {
        if (j >= sql.length) return null;
        if (sql[j] === '"' && sql[j + 1] !== '"') break;
        name += sql[j];
        j += sql[j] === '"' ? 2 : 1;
      }
      const safe = name.toLowerCase().replace(/[^a-z0-9_$\u0080-￿]/g, "_");
      out += ` "${safe || "_"}" `;
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const param = /^\$\d+/.exec(sql.slice(i));
      if (param) {
        out += param[0];
        i += param[0].length;
        continue;
      }
      const tag = DOLLAR_TAG.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end === -1) return null;
        i = end + tag[0].length;
        out += " '' ";
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

function classifyStatement(statement: string): string | null {
  const full = statement.toLowerCase().replace(/\s+/g, " ").trim();
  // Keyword checks must not see quoted names such as a column called "update".
  let text = full.replace(/"[^"]*"/g, " quoted_ident ");
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
  for (const call of full.matchAll(new RegExp(`${NAME}\\s*\\(`, "g"))) {
    const name = call[1] ?? call[2];
    if (MUTATING_FUNCTIONS.test(name)) return `mutating function ${name}()`;
  }
  // Extension schemas (pg_net, pg_cron, vault, …) expose side-effecting calls.
  const qualified = new RegExp(`${NAME}\\s*\\.\\s*${NAME}\\s*\\(`, "g");
  for (const call of full.matchAll(qualified)) {
    const schema = call[1] ?? call[2];
    if (schema !== "pg_catalog") return `schema-qualified call ${schema}.…()`;
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
      reason: 'unparseable SQL (unterminated literal or comment, or U&"…")',
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
