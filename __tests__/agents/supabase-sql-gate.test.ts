import {
  classifySql,
  decide,
  stripSql,
} from "../../.claude/hooks/supabase-sql-gate";

const UNPARSEABLE =
  'unparseable SQL (unterminated literal or comment, or U&"…")';

const sqlInput = (query: unknown, permission_mode = "default") => ({
  hook_event_name: "PreToolUse",
  tool_name: "mcp__supabase__execute_sql",
  permission_mode,
  tool_input: { project_id: "ref", query },
});

describe("classifySql", () => {
  it.each([
    ['SELECT id, status FROM "Payment" WHERE id = $1'],
    ["select count(*) from pg_stat_activity"],
    ["WITH recent AS (SELECT * FROM t) SELECT * FROM recent"],
    ["EXPLAIN SELECT * FROM t"],
    ["EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM t"],
    ["SHOW statement_timeout"],
    ["SELECT pg_catalog.pg_get_constraintdef(oid) FROM pg_constraint"],
    ["(SELECT 1) UNION (SELECT 2)"],
  ])("allows the read %s", (query) => {
    expect(classifySql(query)).toEqual({ readOnly: true, statements: 1 });
  });

  it("allows a batch of reads in one call", () => {
    expect(
      classifySql(
        `SELECT 1;\nSELECT count(*) FROM "Payment";\n-- trailing note\nSELECT now();`,
      ),
    ).toEqual({ readOnly: true, statements: 3 });
  });

  it("asks when one statement of a batch writes", () => {
    expect(
      classifySql("SELECT 1; UPDATE \"Payment\" SET status = 'FAILED'"),
    ).toEqual({
      readOnly: false,
      reason: "UPDATE",
    });
  });

  it.each([
    [
      "WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone",
      "data-modifying CTE (DELETE)",
    ],
    [
      "WITH x AS (INSERT INTO t VALUES (1) RETURNING id) SELECT id FROM x",
      "data-modifying CTE (INSERT)",
    ],
    ["SELECT setval('t_id_seq', 1)", "mutating function setval()"],
    ["SELECT nextval('t_id_seq')", "mutating function nextval()"],
    [
      "SELECT pg_terminate_backend(123)",
      "mutating function pg_terminate_backend()",
    ],
    ["SELECT set_config('x', 'y', false)", "mutating function set_config()"],
    ["SELECT lo_unlink(42)", "mutating function lo_unlink()"],
    [
      "SELECT dblink_exec('conn', 'drop table t')",
      "mutating function dblink_exec()",
    ],
    [
      "SELECT net.http_post('https://x', '{}')",
      "mutating function http_post()",
    ],
    [
      "SELECT cron.schedule('j', '* * * * *', 'delete from t')",
      "schema-qualified call cron.…()",
    ],
    ["SELECT * INTO backup FROM t", "SELECT … INTO"],
    ["SELECT * FROM t FOR UPDATE", "row lock (FOR UPDATE/SHARE)"],
    ["SELECT * FROM t FOR KEY SHARE", "row lock (FOR UPDATE/SHARE)"],
    ["EXPLAIN ANALYZE DELETE FROM t", "EXPLAIN DELETE"],
    ["CREATE TABLE t (id int)", "CREATE"],
    ["ALTER TABLE t DROP COLUMN x", "ALTER"],
    ["DROP INDEX payment_unique", "DROP"],
    ["INSERT INTO t VALUES (1)", "INSERT"],
    ['DELETE FROM "Payment"', "DELETE"],
    ["TRUNCATE t", "TRUNCATE"],
    ["COPY t FROM '/tmp/x'", "COPY"],
    ["CALL do_things()", "CALL"],
    ["DO $$ BEGIN DELETE FROM t; END $$", "DO"],
    ["SET statement_timeout = 0", "SET"],
    ["LOCK TABLE t", "LOCK"],
    ["VACUUM t", "VACUUM"],
    ["BEGIN; SELECT 1; COMMIT", "BEGIN, COMMIT"],
  ])("asks for %s", (query, reason) => {
    expect(classifySql(query)).toEqual({ readOnly: false, reason });
  });

  it("ignores write keywords inside string literals, identifiers and comments", () => {
    expect(
      classifySql(
        `SELECT 'DELETE FROM t; DROP TABLE x' AS note, "update" FROM t -- INSERT INTO t\n/* UPDATE t SET a = 1 */ WHERE a = E'it\\'s; delete' AND b = $tag$ drop table t; $tag$`,
      ),
    ).toEqual({ readOnly: true, statements: 1 });
  });

  it("still sees a write hidden after a comment or a string", () => {
    expect(classifySql("SELECT '--'; DELETE FROM t")).toEqual({
      readOnly: false,
      reason: "DELETE",
    });
    expect(classifySql("/* select */ DELETE FROM t")).toEqual({
      readOnly: false,
      reason: "DELETE",
    });
  });

  it.each([
    [`SELECT "setval"('t_id_seq', 1)`, "mutating function setval()"],
    [`SELECT pg_catalog."setval"('t_id_seq', 1)`, "mutating function setval()"],
    [
      `SELECT pg_catalog."set_config"('x', 'y', false)`,
      "mutating function set_config()",
    ],
    [
      `SELECT "cron"."schedule"('j', '* * * * *', 'x')`,
      "schema-qualified call cron.…()",
    ],
    [`SELECT U&"\\0073etval"('s', 1)`, UNPARSEABLE],
    [
      "SELECT pg_catalog.now(), cron.unschedule('j')",
      "schema-qualified call cron.…()",
    ],
    [
      "SELECT pg_logical_emit_message(false, 'x', 'y')",
      "mutating function pg_logical_emit_message()",
    ],
    [
      "SELECT pg_stat_statements_reset()",
      "mutating function pg_stat_statements_reset()",
    ],
    [
      "SELECT brin_summarize_new_values('i')",
      "mutating function brin_summarize_new_values()",
    ],
    ["SELECT 1 AS a$$$; DELETE FROM t; -- $$\n", "DELETE"],
    ["SELECT $é$ '$é$; DELETE FROM t; -- '", "DELETE"],
    ["SELECT 1; -- note\rDELETE FROM t", "DELETE"],
  ])("asks for the disguised write %s", (query, reason) => {
    expect(classifySql(query)).toEqual({ readOnly: false, reason });
  });

  it.each([
    ['SELECT "id", "status" FROM "Payment" WHERE "update" IS NULL'],
    ['SELECT "a""b" FROM t'],
    ["SELECT $é$ ; delete $é$ AS note"],
    ["SELECT a$b, $1 FROM t"],
    ['SELECT pg_catalog."pg_get_constraintdef"(oid) FROM pg_constraint'],
  ])("allows the quoted or tagged read %s", (query) => {
    expect(classifySql(query)).toEqual({ readOnly: true, statements: 1 });
  });

  it.each([
    ["", "empty or missing query"],
    ["   ", "empty or missing query"],
    [undefined, "empty or missing query"],
    [42, "empty or missing query"],
    ["SELECT 'unterminated", UNPARSEABLE],
    ["SELECT 1 /* open comment", UNPARSEABLE],
    ["SELECT $q$ never closed", UNPARSEABLE],
    [";;", "no SQL statement"],
    ["}{ garbage", "unparsed statement"],
  ])("asks for garbage input %p", (query, reason) => {
    expect(classifySql(query)).toEqual({ readOnly: false, reason });
  });
});

describe("stripSql", () => {
  it("keeps statement separators outside literals only", () => {
    expect(stripSql("SELECT 'a;b'; SELECT 2")?.split(";")).toHaveLength(2);
  });
});

describe("decide", () => {
  it("allows a read-only batch without a prompt", () => {
    expect(
      decide(sqlInput("SELECT 1; SELECT 2")).hookSpecificOutput,
    ).toMatchObject({
      permissionDecision: "allow",
    });
  });

  it("asks for a write and names the statement and the shared database", () => {
    const out = decide(sqlInput("DELETE FROM t")).hookSpecificOutput;
    expect(out.permissionDecision).toBe("ask");
    expect(out.permissionDecisionReason).toContain("DELETE");
    expect(out.permissionDecisionReason).toContain("shared dev+prod database");
  });

  it("denies a write in bypassPermissions mode and says how to get approval", () => {
    const out = decide(
      sqlInput("DROP TABLE t", "bypassPermissions"),
    ).hookSpecificOutput;
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain("Shift+Tab");
  });

  it("still allows a read in bypassPermissions mode", () => {
    expect(
      decide(sqlInput("SELECT 1", "bypassPermissions")).hookSpecificOutput,
    ).toMatchObject({
      permissionDecision: "allow",
    });
  });

  it.each([[null], ["not json"], [{}], [{ tool_input: "x" }]])(
    "asks on malformed input %p",
    (input) => {
      expect(decide(input).hookSpecificOutput.permissionDecision).toBe("ask");
    },
  );
});
