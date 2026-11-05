# Experiment source code (2026-10-31)

These are the throwaway scripts behind the experiment reports in this folder. They are kept as text so that lint, typecheck and the build ignore them. They are throwaway scripts, not production code: some create recurring QStash schedules (`lab-pg/q10.mjs`, `lab-netlify-qstash/t3.mjs`) that the original run deleted by hand afterwards, so delete any schedule you create; polling loops may serialise a still-running task as the final result, so check the status field; `lab-lock/runall.mjs` compared clocks across machines and its interference result was discarded in favour of `lab-lock/runall2.mjs`, which uses the database clock; and the Trigger.dev environment-variable helpers upload a database URL as an ordinary variable, which is acceptable only for a disposable mock database. Most probes read credentials from environment variables, but some read local files: the repository's `.env`, a local `.secrets` file or a Trigger CLI config file (those reads are shown as placeholders where they were replaced). Several probes disable TLS verification (`rejectUnauthorized: false` or TLS off) because they ran once against a mock database: do not copy those settings, keep certificate verification on.

## `lab-inngest/app.mjs`

```js
import http from "node:http";
import fs from "node:fs";
import { Inngest } from "inngest";
import { serve } from "inngest/node";

const T0 = Date.now();
const ts = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(new Date().toISOString(), ts(), ...a);
const SIDE = "logs/side-effects.log";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inngest = new Inngest({ id: "lab", isDev: true });

const three = (id, checkpointing) =>
  inngest.createFunction(
    {
      id,
      triggers: [{ event: `lab/${id}` }],
      ...(checkpointing === undefined ? {} : { checkpointing }),
    },
    async ({ step }) => {
      for (const n of [1, 2, 3])
        await step.run(`s${n}`, async () => {
          log(`  [${id}] step s${n} body start`);
          await sleep(1000);
          return n;
        });
      log(`  [${id}] DONE`);
      return "ok";
    },
  );

const fns = [
  three("A-default"),
  three("A-off", false),
  ...[
    ["B-40s", "lab/B", undefined],
    ["B-40s-off", "lab/B-off", false],
  ].map(([id, ev, cp]) =>
    inngest.createFunction(
      {
        id,
        triggers: [{ event: ev }],
        retries: 2,
        ...(cp === undefined ? {} : { checkpointing: cp }),
      },
      async ({ step, attempt }) => {
        await step.run("long", async () => {
          fs.appendFileSync(
            SIDE,
            `${new Date().toISOString()} ${id} side-effect attempt=${attempt}\n`,
          );
          log(`  [B] long step start attempt=${attempt}`);
          await sleep(40000);
          log(`  [B] long step end (40s elapsed) attempt=${attempt}`);
        });
        log("  [B] DONE");
      },
    ),
  ),
  ...[
    ["C-default", undefined],
    ["C-limit20", { maxRuntime: "20s" }],
    ["C-nolimit", { maxRuntime: 0 }],
  ].map(([id, cp]) =>
    inngest.createFunction(
      {
        id,
        triggers: [{ event: `lab/${id}` }],
        retries: 1,
        ...(cp ? { checkpointing: cp } : {}),
      },
      async ({ step }) => {
        for (let n = 1; n <= 10; n++)
          await step.run(`t${n}`, async () => {
            log(`  [${id}] step t${n} start`);
            await sleep(5000);
            return n;
          });
        log(`  [${id}] DONE`);
      },
    ),
  ),
  inngest.createFunction(
    { id: "D-sleep", triggers: [{ event: "lab/D" }] },
    async ({ step }) => {
      await step.run("before", () => log("  [D] before"));
      await step.sleep("nap", "10s");
      await step.run("after", () => log("  [D] after"));
    },
  ),
  inngest.createFunction(
    { id: "E-cron", triggers: [{ cron: "* * * * *" }] },
    async ({ step }) => {
      await step.run("tick", () => log("  [E] cron tick body"));
    },
  ),
];

const handler = serve({ client: inngest, functions: fns });
http
  .createServer((req, res) => {
    const start = Date.now();
    const u = new URL(req.url, "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let info = "";
      try {
        const j = JSON.parse(body);
        info = `ctx.attempt=${j.ctx?.attempt} stack=${j.ctx?.stack?.stack?.length ?? "?"} steps=${Object.keys(j.steps || {}).length}`;
      } catch {}
      log(`REQ> ${req.method} ${u.search} ${info}`);
      res.on("finish", () =>
        log(
          `REQ< ${req.method} ${u.search} status=${res.statusCode} took=${((Date.now() - start) / 1000).toFixed(1)}s`,
        ),
      );
      res.on("close", () => {
        if (!res.writableFinished)
          log(
            `REQ! ${req.method} ${u.search} connection closed early after ${((Date.now() - start) / 1000).toFixed(1)}s`,
          );
      });
      // replay body for the adapter
      const Readable = StreamReadable;
      const r = Readable.from([Buffer.from(body)]);
      r.method = req.method;
      r.url = req.url;
      r.headers = req.headers;
      handler(r, res);
    });
  })
  .listen(3000, () => log("app listening :3000"));
function require_stream() {
  return { Readable: StreamReadable };
}
import { Readable as StreamReadable } from "node:stream";
```

## `lab-inngest/proxy.mjs`

```js
import http from "node:http";
const T0 = Date.now();
const log = (...a) =>
  console.log(
    new Date().toISOString(),
    `+${((Date.now() - T0) / 1000).toFixed(1)}s`,
    ...a,
  );
const LIMIT = 26000;
http
  .createServer((req, res) => {
    const start = Date.now();
    let answered = false;
    const u = new URL(req.url, "http://x");
    const timer = setTimeout(() => {
      if (answered) return;
      answered = true;
      log(`PROXY 504 (no headers in 26s) ${req.method} ${u.search}`);
      res.writeHead(504, { "content-type": "text/plain" });
      res.end("Gateway Timeout (simulated netlify edge)");
    }, LIMIT);
    const up = http.request(
      {
        host: "127.0.0.1",
        port: 3000,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (ur) => {
        if (answered) {
          log(
            `PROXY upstream finished late after ${((Date.now() - start) / 1000).toFixed(1)}s status=${ur.statusCode} (response discarded) ${u.search}`,
          );
          ur.resume();
          return;
        }
        answered = true;
        clearTimeout(timer);
        log(
          `PROXY pass ${ur.statusCode} after ${((Date.now() - start) / 1000).toFixed(1)}s ${u.search}`,
        );
        res.writeHead(ur.statusCode, ur.headers);
        ur.pipe(res);
      },
    );
    up.on("error", (e) => {
      if (!answered) {
        answered = true;
        res.writeHead(502);
        res.end(String(e));
      }
    });
    req.pipe(up);
  })
  .listen(3001, () => log("proxy :3001 -> :3000"));
```

## `lab-inngest/send.mjs`

```js
import { Inngest } from "inngest";
const i = new Inngest({ id: "lab", isDev: true });
console.log(await i.send({ name: process.argv[2], data: {} }));
```

## `lab-pg/boss.mjs`

```js
import { PgBoss } from "pg-boss";
import pg from "pg";
const URL = process.env.DB_URL || "postgres://postgres@localhost:54329/boss";
const LOGURL = "postgres://postgres@localhost:54329/boss";
const [, , mode, name = "w", arg] = process.argv;
const logPool = new pg.Pool({
  connectionString: LOGURL,
  max: 2,
  application_name: "lab-logger",
});
const ev = (src, info) =>
  logPool.query("insert into events(src,info,pid) values($1,$2,$3)", [
    src,
    String(info),
    process.pid,
  ]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opts = {
  connectionString: URL,
  application_name: `pgboss-${name}`,
  useListenNotify: process.env.LN === "1",
  max: Number(process.env.POOL_MAX || 10),
};
if (process.env.PGB === "1") opts.schedule = true;
const boss = new PgBoss(opts);
boss.on("error", (e) => console.error("boss error", e.message));
boss.on("warning", (e) =>
  console.error("boss warning", JSON.stringify(e).slice(0, 300)),
);

if (mode === "worker") {
  await boss.start();
  const heartbeat = process.env.HB
    ? { heartbeatSeconds: Number(process.env.HB) }
    : {};
  for (const q of ["cron_q", "delayed_q", "immed_q", "crash_q", "conc_q"]) {
    await boss.createQueue(
      q,
      q === "crash_q"
        ? {
            retryLimit: 3,
            expireInSeconds: Number(process.env.EXPIRE || 900),
            ...heartbeat,
          }
        : {},
    );
  }
  if (process.env.LN === "1")
    await boss.updateQueue("immed_q", { notify: true });
  if (process.env.CRON === "1")
    await boss.schedule("cron_q", "* * * * *", { n: 1 });
  await boss.work("cron_q", async ([j]) => {
    await ev("cron", `${name} job=${j.id}`);
  });
  await boss.work("delayed_q", async ([j]) => {
    await ev(
      "delayed",
      `${name} target=${j.data.target} fired=${Date.now()} lateMs=${Date.now() - j.data.target}`,
    );
  });
  await boss.work("immed_q", async ([j]) => {
    await ev("immed", `${name} latMs=${Date.now() - j.data.sentAt}`);
  });
  await boss.createQueue("crash_q2", { retryLimit: 3, expireInSeconds: 45 });
  for (const cq of ["crash_q", "crash_q2"])
    await boss.work(cq, async ([j]) => {
      await ev("crash", `${name} START job=${j.id}`);
      await logPool.query("insert into side_effect(key,pid) values($1,$2)", [
        `step1:${j.id}`,
        process.pid,
      ]);
      await ev("crash", "step1 done");
      await ev("crash", "step2 begin");
      await sleep(20000);
      await ev("crash", "step2 done");
      await ev("crash", "step3 done");
    });
  await boss.work(
    "conc_q",
    {
      localConcurrency: Number(process.env.CONC || 2),
      pollingIntervalSeconds: 0.5,
    },
    async ([j]) => {
      await ev("conc", `${name} start ${j.data.i}`);
      await sleep(2000);
      await ev("conc", `${name} end ${j.data.i}`);
    },
  );
  console.log(name, "ready pid", process.pid);
  process.on("SIGTERM", async () => {
    await boss.stop({ graceful: false });
    process.exit(0);
  });
} else if (mode === "send") {
  await boss.start();
  if (arg === "delayed") {
    const target = Date.now() + 30000;
    await boss.send("delayed_q", { target }, { startAfter: new Date(target) });
    await ev("delayed", `sent target=${target}`);
  }
  if (arg === "immed") {
    for (let i = 0; i < 20; i++) {
      await boss.send("immed_q", { sentAt: Date.now() });
      await sleep(1500);
    }
  }
  if (arg === "crash") {
    for (const q of ["crash_q", "crash_q2"]) {
      const id = await boss.send(q, {});
      await ev("crash", `sent ${q} job=${id}`);
    }
  }
  if (arg === "conc") {
    for (let i = 0; i < 20; i++) await boss.send("conc_q", { i });
    await ev("conc", "sent 20");
  }
  if (arg === "tx") {
    const c = new pg.Client({ connectionString: URL });
    await c.connect();
    const db = { executeSql: async (text, values) => c.query(text, values) };
    for (const commit of [false, true]) {
      await c.query("begin");
      await c.query("insert into booking(note) values($1)", [
        commit ? "commit" : "rollback",
      ]);
      const id = await boss.send(
        "immed_q",
        { sentAt: Date.now(), tx: commit ? "commit" : "rollback" },
        { db },
      );
      console.log(commit ? "COMMIT" : "ROLLBACK", "send returned id", id);
      await c.query(commit ? "commit" : "rollback");
      const r = await c.query(
        "select id, data from pgboss.job where name='immed_q' and data->>'tx'=$1",
        [commit ? "commit" : "rollback"],
      );
      console.log(
        " after",
        commit ? "commit" : "rollback",
        "jobs found:",
        r.rowCount,
        JSON.stringify(r.rows),
      );
    }
    await c.end();
  }
  await boss.stop({ graceful: false });
  await logPool.end();
}
```

## `lab-pg/dbos.mjs`

```js
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import pg from "pg";
const URL = process.env.DB_URL || "postgres://postgres@localhost:54329/dbos";
const LOGURL = "postgres://postgres@localhost:54329/dbos";
const [, , mode, name = "w", arg] = process.argv;
const logPool = new pg.Pool({
  connectionString: LOGURL,
  max: 2,
  application_name: "lab-logger",
});
const ev = (src, info) =>
  logPool.query("insert into events(src,info,pid) values($1,$2,$3)", [
    src,
    String(info),
    process.pid,
  ]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cronWf = DBOS.registerWorkflow(
  async (sched, ctx) => {
    await DBOS.runStep(
      () =>
        ev(
          "cron",
          `${name} sched=${sched.toISOString()} wf=${DBOS.workflowID}`,
        ),
      { name: "logcron" },
    );
  },
  { name: "cronWf" },
);
const delayedWf = DBOS.registerWorkflow(
  async (target) => {
    await DBOS.runStep(
      () =>
        ev(
          "delayed",
          `${name} target=${target} fired=${Date.now()} lateMs=${Date.now() - target}`,
        ),
      { name: "logdelayed" },
    );
  },
  { name: "delayedWf" },
);
const immedWf = DBOS.registerWorkflow(
  async (sentAt) => {
    await DBOS.runStep(
      () => ev("immed", `${name} latMs=${Date.now() - sentAt}`),
      { name: "logimmed" },
    );
  },
  { name: "immedWf" },
);
const crashWf = DBOS.registerWorkflow(
  async () => {
    const id = DBOS.workflowID;
    await DBOS.runStep(
      async () => {
        await ev("crash", `${name} step1 run wf=${id}`);
        await logPool.query("insert into side_effect(key,pid) values($1,$2)", [
          `step1:${id}`,
          process.pid,
        ]);
      },
      { name: "step1" },
    );
    await DBOS.runStep(
      async () => {
        await ev("crash", "step2 begin");
        await sleep(20000);
        await ev("crash", "step2 done");
        return "two";
      },
      { name: "step2" },
    );
    await DBOS.runStep(
      async () => {
        await ev("crash", "step3 done");
        return "three";
      },
      { name: "step3" },
    );
  },
  { name: "crashWf" },
);
const concWf = DBOS.registerWorkflow(
  async (i) => {
    await DBOS.runStep(
      async () => {
        await ev("conc", `${name} start ${i}`);
        await sleep(2000);
        await ev("conc", `${name} end ${i}`);
      },
      { name: "work" },
    );
  },
  { name: "concWf" },
);

DBOS.setConfig({
  name: "lab",
  systemDatabaseUrl: URL,
  logLevel: "info",
  systemDatabasePoolSize: Number(process.env.POOL_MAX || 10),
});
if (mode === "worker") {
  await DBOS.launch();
  await DBOS.registerQueue("dq", { minPollingIntervalMs: 1000 });
  await DBOS.registerQueue("conc", {
    concurrency: Number(process.env.CONC || 2),
    minPollingIntervalMs: 500,
  });
  if (process.env.CRON === "1")
    await DBOS.applySchedules([
      {
        scheduleName: "every-minute",
        workflowFn: cronWf,
        schedule: "* * * * *",
      },
    ]);
  console.log(name, "ready pid", process.pid);
  process.on("SIGTERM", async () => {
    await DBOS.shutdown();
    process.exit(0);
  });
  await new Promise(() => {});
} else if (mode === "send") {
  const client = await DBOSClient.create({ systemDatabaseUrl: URL });
  if (arg === "delayed") {
    const target = Date.now() + 30000;
    await client.enqueue(
      { queueName: "dq", workflowName: "delayedWf", delaySeconds: 30 },
      target,
    );
    await ev("delayed", `sent target=${target}`);
  }
  if (arg === "immed") {
    for (let i = 0; i < 20; i++) {
      await client.enqueue(
        { queueName: "dq", workflowName: "immedWf" },
        Date.now(),
      );
      await sleep(1500);
    }
  }
  if (arg === "crash") {
    const h = await client.enqueue({
      queueName: "dq",
      workflowName: "crashWf",
      workflowID: "crash-1",
    });
    await ev("crash", "sent crash-1");
  }
  if (arg === "conc") {
    for (let i = 0; i < 20; i++)
      await client.enqueue({ queueName: "conc", workflowName: "concWf" }, i);
    await ev("conc", "sent 20");
  }
  if (arg === "tx") {
    const c = new pg.Client({ connectionString: URL });
    await c.connect();
    for (const commit of [false, true]) {
      const wfid = commit ? "tx-commit" : "tx-rollback";
      await c.query("begin");
      await c.query("insert into booking(note) values($1)", [wfid]);
      await client.enqueueInTransaction(
        c,
        { queueName: "dq", workflowName: "immedWf", workflowID: wfid },
        Date.now(),
      );
      await c.query(commit ? "commit" : "rollback");
      const r = await c.query(
        "select workflow_uuid,status from dbos.workflow_status where workflow_uuid=$1",
        [wfid],
      );
      console.log(
        commit ? "COMMIT" : "ROLLBACK",
        "workflow rows:",
        r.rowCount,
        JSON.stringify(r.rows),
      );
    }
    await c.end();
  }
  await client.destroy();
  await logPool.end();
  process.exit(0);
}
```

## `lab-pg/q10.mjs`

```js
// Usage: node q10.mjs <boss|dbos|rtt|setup|cleanup> <URL-env-name> [cron]
import pg from "pg";
const [, , lib, envName, cron] = process.argv;
const URL = process.env[envName];
const host = new globalThis.URL(
  URL.replace(/^postgresql:/, "http:"),
).host.replace(/^.*@/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) =>
  console.log(
    `[${lib} ${host} +${((Date.now() - t0) / 1000).toFixed(1)}s]`,
    ...a,
  );
const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return {
    median: s[Math.floor(s.length / 2)],
    p95: s[Math.floor(s.length * 0.95)],
  };
};

if (lib === "rtt") {
  const c = new pg.Client({ connectionString: URL });
  const ct = Date.now();
  await c.connect();
  const conn = Date.now() - ct;
  const ts = [];
  for (let i = 0; i < 50; i++) {
    const s = performance.now();
    await c.query("select 1");
    ts.push(+(performance.now() - s).toFixed(1));
  }
  log("connect ms", conn, "SELECT 1 (laptop, not representative)", med(ts));
  await c.end();
}
if (lib === "setup" || lib === "cleanup") {
  const c = new pg.Client({ connectionString: URL });
  await c.connect();
  if (lib === "setup") {
    await c.query("create schema if not exists lab_biz");
    await c.query(
      "create table if not exists lab_biz.booking(id serial primary key, note text, at timestamptz default now())",
    );
    log("lab_biz ready");
  } else {
    for (const s of ["lab_pgboss", "lab_dbos", "lab_biz"])
      await c.query(`drop schema if exists ${s} cascade`);
    const r = await c.query(
      "select nspname from pg_namespace where nspname like 'lab_%'",
    );
    log("remaining lab_ schemas:", r.rowCount, JSON.stringify(r.rows));
  }
  await c.end();
}
if (lib === "boss") {
  const { PgBoss } = await import("pg-boss");
  const boss = new PgBoss({
    connectionString: URL,
    schema: "lab_pgboss",
    max: 2,
    schedule: cron === "cron",
    application_name: "lab-q10-boss",
  });
  boss.on("error", (e) => log("ERROR", e.message));
  try {
    await boss.start();
    log("start/install OK");
  } catch (e) {
    log("START FAILED", e.message);
    process.exit(1);
  }
  const q = "q10_" + envName.toLowerCase();
  await boss.createQueue(q);
  const lat = [];
  await boss.work(q, { pollingIntervalSeconds: 0.5 }, async ([j]) => {
    if (j.data.sentAt) lat.push(Date.now() - j.data.sentAt);
    if (j.data.cron) log("CRON fired job", j.id);
  });
  for (let i = 0; i < 10; i++) {
    await boss.send(q, { sentAt: Date.now() });
    await sleep(700);
  }
  await sleep(3000);
  log("send+work: processed", lat.length, "/10; enqueue->start ms", med(lat));
  const c = new pg.Client({ connectionString: URL });
  await c.connect();
  const db = { executeSql: (text, values) => c.query(text, values) };
  for (const commit of [false, true]) {
    try {
      await c.query("begin");
      await c.query("insert into lab_biz.booking(note) values($1)", [
        `boss-${commit}`,
      ]);
      await boss.send(q, { tx: String(commit) }, { db });
      await c.query(commit ? "commit" : "rollback");
      const r = await c.query(
        `select count(*)::int n from lab_pgboss.job where name=$1 and data->>'tx'=$2`,
        [q, String(commit)],
      );
      const b = await c.query(
        "select count(*)::int n from lab_biz.booking where note=$1",
        [`boss-${commit}`],
      );
      log(
        commit ? "COMMIT" : "ROLLBACK",
        "jobs:",
        r.rows[0].n,
        "bookings:",
        b.rows[0].n,
      );
    } catch (e) {
      log("TX TEST FAILED", e.message);
      try {
        await c.query("rollback");
      } catch {}
    }
  }
  await c.end();
  if (cron === "cron") {
    await boss.schedule(q, "* * * * *", { cron: true });
    log("scheduled every-minute cron; waiting up to 130s");
    await sleep(130000);
  }
  const conns = new pg.Client({ connectionString: URL });
  await conns.connect();
  await boss.stop({ graceful: false });
  await conns.end();
  log("stopped");
}
if (lib === "dbos") {
  process.env.DBOS__APPVERSION = "q10";
  const { DBOS, DBOSClient } = await import("@dbos-inc/dbos-sdk");
  const lat = [];
  const wf = DBOS.registerWorkflow(
    async (sentAt) => {
      await DBOS.runStep(
        async () => {
          if (sentAt) lat.push(Date.now() - sentAt);
        },
        { name: "s1" },
      );
    },
    { name: "q10wf" },
  );
  const cw = DBOS.registerWorkflow(
    async () => {
      await DBOS.runStep(async () => log("CRON fired"), { name: "c" });
    },
    { name: "q10cron" },
  );
  DBOS.setConfig({
    name: "lab-q10",
    systemDatabaseUrl: URL,
    systemDatabaseSchemaName: "lab_dbos",
    systemDatabasePoolSize: Number(process.env.POOL || 10),
    logLevel: "warn",
  });
  try {
    await DBOS.launch();
    log("launch/migrate OK");
  } catch (e) {
    log("LAUNCH FAILED", e.message);
    process.exit(1);
  }
  await DBOS.registerQueue("q10", { minPollingIntervalMs: 500 });
  const client = await DBOSClient.create({
    systemDatabaseUrl: URL,
    systemDatabaseSchemaName: "lab_dbos",
    systemDatabasePoolSize: 2,
  });
  for (let i = 0; i < 10; i++) {
    await client.enqueue(
      { queueName: "q10", workflowName: "q10wf", appVersion: "q10" },
      Date.now(),
    );
    await sleep(700);
  }
  await sleep(4000);
  log("enqueue+run: processed", lat.length, "/10; enqueue->start ms", med(lat));
  const c = new pg.Client({ connectionString: URL });
  await c.connect();
  for (const commit of [false, true]) {
    const id = `q10-${envName}-${commit}-${Date.now()}`;
    try {
      await c.query("begin");
      await c.query("insert into lab_biz.booking(note) values($1)", [
        `dbos-${commit}`,
      ]);
      await client.enqueueInTransaction(
        c,
        {
          queueName: "q10",
          workflowName: "q10wf",
          workflowID: id,
          appVersion: "q10",
        },
        0,
      );
      await c.query(commit ? "commit" : "rollback");
      const r = await c.query(
        "select count(*)::int n from lab_dbos.workflow_status where workflow_uuid=$1",
        [id],
      );
      log(commit ? "COMMIT" : "ROLLBACK", "workflows:", r.rows[0].n);
    } catch (e) {
      log("TX TEST FAILED", e.message);
      try {
        await c.query("rollback");
      } catch {}
    }
  }
  await c.end();
  await client.destroy();
  if (cron === "cron") {
    try {
      await DBOS.applySchedules([
        {
          scheduleName: "q10-every-minute",
          workflowFn: cw,
          schedule: "* * * * *",
        },
      ]);
      log("cron scheduled; waiting up to 130s");
      await sleep(130000);
    } catch (e) {
      log("CRON FAILED", e.message);
    }
  }
  await DBOS.shutdown();
  log("stopped");
}
process.exit(0);
```

## `lab-trigger/api.mjs`

```js
export const base = process.env.TRIGGER_API_URL;
export const PAT = process.env.TRIGGER_API_TOKEN;
export const REF = "proj_<project-ref>";
export async function api(method, path, body, token = PAT) {
  const r = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    j = t;
  }
  return { status: r.status, body: j };
}
```

## `lab-trigger/envset.mjs`

Its response logging redacts only `postgresql://` URLs, so a `postgres://` value would be printed; log only the status and name. This script uploads database URLs as ordinary Trigger.dev environment variables, which the API returns in plain text. That was acceptable only for a disposable mock database and a same-session cleanup. For anything else, mark the variables secret or pass them another way.

```js
import { api, REF } from "./api.mjs";
const act = process.argv[2];
if (act === "set") {
  const db = process.env.DATABASE_URL.split("?")[0],
    direct = process.env.DIRECT_URL;
  for (const [name, value] of [
    ["PROBE_DB_URL", db],
    ["PROBE_DIRECT_URL", direct],
  ]) {
    const r = await api("POST", `/api/v1/projects/${REF}/envvars/prod`, {
      name,
      value,
    });
    console.log("set", name, r.status);
  }
}
const list = await api("GET", `/api/v1/projects/${REF}/envvars/prod`);
console.log(
  "list",
  list.status,
  Array.isArray(list.body)
    ? list.body.map((e) => e.name)
    : "(response body not logged)",
);
if (act === "del") {
  for (const name of ["PROBE_DB_URL", "PROBE_DIRECT_URL"]) {
    const r = await api(
      "DELETE",
      `/api/v1/projects/${REF}/envvars/prod/${name}`,
    );
    console.log("del", name, r.status);
  }
  const l2 = await api("GET", `/api/v1/projects/${REF}/envvars/prod`);
  console.log(
    "after",
    l2.status,
    Array.isArray(l2.body) ? l2.body.map((e) => e.name) : l2.body,
  );
}
```

## `lab-trigger/local.mjs`

```js
import { runProbe } from "./src/probe.mjs";
console.log(JSON.stringify(await runProbe(), null, 1));
```

## `lab-trigger/probe.mjs`

```js
import pg from "pg";

const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};
const r = (n) => Math.round(n * 100) / 100;
const now = () => performance.now();

async function probeOne(url) {
  const out = {};
  const u = new URL(url);
  out.target = `${u.hostname}:${u.port}`;
  const client = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
  let t = now();
  await client.connect();
  out.connectMs = r(now() - t);
  const lat = [];
  for (let i = 0; i < 50; i++) {
    t = now();
    await client.query("SELECT 1");
    lat.push(now() - t);
  }
  out.select1 = {
    medianMs: r(pct(lat, 0.5)),
    p95Ms: r(pct(lat, 0.95)),
    minMs: r(Math.min(...lat)),
    maxMs: r(Math.max(...lat)),
  };
  const tabs = (
    await client.query(
      "select table_name from information_schema.tables where table_schema='public'",
    )
  ).rows.map((x) => x.table_name);
  const has = (n) => tabs.includes(n);
  const mix = [];
  const P = has("Payment"),
    A = has("Appointment"),
    S = has("SystemJobExecution");
  const qs = [];
  if (P)
    qs.push(
      'SELECT id, "paymentStatus" FROM "Payment" ORDER BY "createdAt" DESC LIMIT 50',
      `SELECT count(*) FROM "Payment" WHERE "paymentStatus" = 'SUCCEEDED'`,
    );
  if (A)
    qs.push(
      'SELECT id, "createdAt" FROM "Appointment" ORDER BY "createdAt" DESC LIMIT 50',
      `SELECT count(*) FROM "Appointment" WHERE "createdAt" > now() - interval '30 days'`,
    );
  if (S)
    qs.push(
      'SELECT id, status FROM "SystemJobExecution" ORDER BY "createdAt" DESC LIMIT 50',
    );
  if (!qs.length)
    qs.push(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' LIMIT 50",
    );
  const q20 = Array.from({ length: 20 }, (_, i) => qs[i % qs.length]);
  const per = [];
  const w0 = now();
  for (const q of q20) {
    t = now();
    try {
      await client.query(q);
    } catch (e) {
      out.mixError = String(e.message).slice(0, 120);
    }
    per.push(now() - t);
  }
  out.mix20 = {
    totalMs: r(now() - w0),
    medianMs: r(pct(per, 0.5)),
    p95Ms: r(pct(per, 0.95)),
    distinctQueries: qs.length,
  };
  out.tablesFound = {
    Payment: P,
    Appointment: A,
    SystemJobExecution: S,
    total: tabs.length,
  };
  await client.end();
  return out;
}

export async function runProbe() {
  const res = { startedAt: new Date().toISOString() };
  try {
    const t = now();
    res.egressIp = await (await fetch("https://api.ipify.org")).text();
    res.ipifyMs = r(now() - t);
  } catch (e) {
    res.egressIp = "ERR " + e.message;
  }
  res.node = process.version;
  const urls = {
    transactionPooler6543: process.env.PROBE_DB_URL,
    sessionPooler5432: process.env.PROBE_DIRECT_URL,
  };
  for (const [k, v] of Object.entries(urls)) {
    if (!v) {
      res[k] = "no url";
      continue;
    }
    try {
      res[k] = await probeOne(v);
    } catch (e) {
      res[k] = {
        error: String(e.message)
          .replace(/\/\/[^@\s]*@/g, "//***@")
          .slice(0, 200),
      };
    }
  }
  return res;
}
```

## `lab-trigger/run.mjs`

```js
import { api, REF, base } from "./api.mjs";
import { configure, tasks, runs } from "@trigger.dev/sdk";
const jwt = (
  await api("POST", `/api/v1/projects/${REF}/prod/jwt`, {
    claims: { scopes: ["write:tasks", "read:runs", "read:tasks"] },
  })
).body.token;
configure({ accessToken: jwt, baseURL: base });
const [region, machine, tag] = process.argv.slice(2);
const opts = { tags: [tag || "probe"] };
if (region !== "default") opts.region = region;
if (machine && machine !== "default") opts.machine = machine;
const h = await tasks.trigger(
  "db-probe",
  { label: `${region}/${machine}` },
  opts,
);
console.log("triggered", h.id);
let run;
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  run = await runs.retrieve(h.id);
  if (
    [
      "COMPLETED",
      "FAILED",
      "CRASHED",
      "SYSTEM_FAILURE",
      "CANCELED",
      "TIMED_OUT",
      "EXPIRED",
    ].includes(run.status)
  )
    break;
}
const t = (x) => (x ? new Date(x).getTime() : null);
const summary = {
  id: h.id,
  region,
  machine: machine || "default",
  status: run.status,
  queueMs: t(run.startedAt) - t(run.createdAt),
  durationMs: run.durationMs,
  costInCents: run.costInCents,
  baseCostInCents: run.baseCostInCents,
};
console.log(JSON.stringify(summary));
const fs = await import("fs");
fs.writeFileSync(
  `result-${region}-${machine || "default"}-${Date.now()}.json`,
  JSON.stringify(
    {
      summary,
      output: run.output,
      error: run.error,
      raw: {
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      },
    },
    null,
    1,
  ),
);
```

## `lab-trigger/trigger.config.ts`

```ts
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_<project-ref>",
  dirs: ["./src/trigger"],
  maxDuration: 300,
  retries: { enabled: false },
  build: { external: ["pg"] },
});
```

The sections below were appended later and cover the lock-hold, Netlify, real-QStash, Vercel, Cloudflare and Netlify Background Functions experiments. Credentials, the Trigger.dev project reference and local paths are replaced with `<...>` placeholders. Only source files are kept: no lockfiles, build output or environment files.

## `lab-lock/`

### `lab-lock/api.mjs`

```js
import fs from "fs";
const cfg = JSON.parse(fs.readFileSync("<trigger-cli-config-path>", "utf8"));
const prof = cfg.profiles[cfg.currentProfile || "default"];
export const base = prof.apiUrl;
export const PAT = prof.accessToken;
export const REF = "<trigger-project-ref>";
export async function api(method, path, body, token = PAT) {
  const r = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    j = t;
  }
  return { status: r.status, body: j };
}
```

### `lab-lock/cleanup.mjs`

```js
import pg from "pg";
import { direct } from "./setup.mjs";
const c = new pg.Client({
  connectionString: direct,
  ssl: { rejectUnauthorized: false },
});
await c.connect();
await c.query("DROP SCHEMA lab_lock CASCADE");
const r = await c.query(
  "select nspname from pg_namespace where nspname like 'lab_%'",
);
console.log(
  "select nspname from pg_namespace where nspname like 'lab_%' ->",
  r.rowCount,
  "rows",
  JSON.stringify(r.rows),
);
await c.end();
```

### `lab-lock/envset.mjs`

```js
import { api, REF } from "./api.mjs";
import { pooler } from "./setup.mjs";
const act = process.argv[2];
if (act === "set") {
  const r = await api("POST", `/api/v1/projects/${REF}/envvars/prod`, {
    name: "LOCK_DB_URL",
    value: pooler,
  });
  console.log("set", r.status);
}
if (act === "del") {
  const r = await api(
    "DELETE",
    `/api/v1/projects/${REF}/envvars/prod/LOCK_DB_URL`,
  );
  console.log("del", r.status);
}
const l = await api("GET", `/api/v1/projects/${REF}/envvars/prod`);
console.log(
  "names",
  Array.isArray(l.body) ? l.body.map((e) => e.name) : l.status,
);
```

### `lab-lock/package.json`

```json
{
  "name": "lab-lock",
  "version": "1.0.0",
  "description": "",
  "main": "index.js",
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "type": "commonjs",
  "dependencies": {
    "@trigger.dev/sdk": "^4.8.3",
    "pg": "^8.23.1"
  },
  "devDependencies": {
    "@types/node": "^26.6.6",
    "@types/pg": "^8.23.1",
    "trigger.dev": "^4.8.3",
    "typescript": "^5.9.3"
  }
}
```

### `lab-lock/reg.mjs`

```js
import { api, REF } from "./api.mjs";
const org = await api("GET", "/api/v2/whoami");
console.log("whoami", org.status, Object.keys(org.body || {}));
for (const p of [
  `/api/v1/projects/${REF.replace("proj_", "")}/regions`,
  `/api/v1/projects/${REF}/regions?projectRef=${REF}`,
]) {
  const r = await api("GET", p);
  console.log(
    p.replace(REF, "REF"),
    r.status,
    typeof r.body === "string"
      ? "html"
      : JSON.stringify(r.body)
          .replace(/\d+\.\d+\.\d+\.\d+/g, "<ip>")
          .slice(0, 600),
  );
}
```

### `lab-lock/runall.mjs`

```js
import fs from "fs";
import { api, REF, base } from "./api.mjs";
import { pooler } from "./setup.mjs";
import { w1, w2, userLoop } from "./src/lock.mjs";
import { configure, tasks, runs } from "@trigger.dev/sdk";
const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return (
    Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] * 10) / 10
  );
};
const st = (a) => ({
  n: a.length,
  median: pct(a, 0.5),
  p95: pct(a, 0.95),
  max: pct(a, 1),
  min: pct(a, 0),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
function analyse(w1res, rec) {
  const inHold = [],
    outHold = [];
  for (const r of rec)
    (w1res.some((h) => r.e >= h.t0Epoch - 300 && r.e <= h.t1Epoch)
      ? inHold
      : outHold
    ).push(r.ms);
  // "affected": update issued during hold window (issue time within [t0,t1])
  const during = rec
    .filter((r) => w1res.some((h) => r.e >= h.t0Epoch && r.e <= h.t1Epoch))
    .map((r) => r.ms);
  const outside = rec
    .filter(
      (r) =>
        !w1res.some((h) => r.e >= h.t0Epoch - 2000 && r.e <= h.t1Epoch + 500),
    )
    .map((r) => r.ms);
  return {
    hold: st(w1res.map((h) => h.holdMs)),
    userDuringHold: st(during),
    userOutsideHold: st(outside),
    userAll: st(rec.map((r) => r.ms)),
  };
}
// 1 baseline
let u = userLoop(pooler);
await sleep(20000);
await u.stop();
out.userBaseline = st(u.rec.map((r) => r.ms));
console.log("baseline", out.userBaseline);
// 2 laptop
u = userLoop(pooler);
await sleep(1500);
const lw1 = await w1(pooler, 10);
await sleep(1000);
await u.stop();
out.laptopW1 = analyse(lw1, u.rec);
out.laptopW1raw = lw1.map((h) => Math.round(h.holdMs));
console.log("laptopW1", out.laptopW1);
out.laptopW2 = await w2(pooler, 20);
console.log("laptopW2", out.laptopW2);
// 3 trigger
const jwt = (
  await api("POST", `/api/v1/projects/${REF}/prod/jwt`, {
    claims: { scopes: ["write:tasks", "read:runs", "read:tasks"] },
  })
).body.token;
configure({ accessToken: jwt, baseURL: base });
u = userLoop(pooler);
await sleep(1500);
const h = await tasks.trigger("lock-probe", {}, { region: "eu-central-1" });
let run;
for (let i = 0; i < 120; i++) {
  await sleep(2000);
  run = await runs.retrieve(h.id);
  if (
    [
      "COMPLETED",
      "FAILED",
      "CRASHED",
      "SYSTEM_FAILURE",
      "CANCELED",
      "TIMED_OUT",
      "EXPIRED",
    ].includes(run.status)
  )
    break;
}
await u.stop();
out.triggerStatus = run.status;
out.triggerError = run.error;
if (run.output) {
  out.triggerW1 = analyse(run.output.w1, u.rec);
  out.triggerW1raw = run.output.w1.map((h) => Math.round(h.holdMs));
  out.triggerW2 = run.output.w2;
  // clock-skew sanity: first hold start vs laptop clock not checked
}
fs.writeFileSync(
  `results-${Date.now()}.json`,
  JSON.stringify({ out, trigRec: u.rec.length }, null, 1),
);
console.log(JSON.stringify(out, null, 1));
```

### `lab-lock/runall2.mjs`

```js
import fs from "fs";
import { api, REF, base } from "./api.mjs";
import { pooler } from "./setup.mjs";
import { w1, w2, userLoop } from "./src/lock.mjs";
import { configure, tasks, runs } from "@trigger.dev/sdk";
const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return (
    Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] * 10) / 10
  );
};
const st = (a) => ({
  n: a.length,
  median: pct(a, 0.5),
  p95: pct(a, 0.95),
  max: pct(a, 1),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
function analyse(w, rec) {
  const issue = (r) => r.dbAt - r.ms + 20;
  const inWin = (t) => w.some((h) => t >= h.dbLockAt && t <= h.dbLastStmtAt);
  const during = rec.filter((r) => inWin(issue(r))).map((r) => r.ms);
  const outside = rec
    .filter(
      (r) =>
        !w.some(
          (h) =>
            issue(r) >= h.dbLockAt - 300 && issue(r) <= h.dbLastStmtAt + 300,
        ),
    )
    .map((r) => r.ms);
  return {
    hold: st(w.map((h) => h.holdMs)),
    userIssuedDuringHold: st(during),
    userIssuedOutside: st(outside),
    userAll: st(rec.map((r) => r.ms)),
    blockedOver150ms: rec.filter((r) => r.ms > 150).length,
  };
}
const jwt = (
  await api("POST", `/api/v1/projects/${REF}/prod/jwt`, {
    claims: { scopes: ["write:tasks", "read:runs", "read:tasks"] },
  })
).body.token;
configure({ accessToken: jwt, baseURL: base });
async function trig(mode) {
  const h = await tasks.trigger(
    "lock-probe",
    { mode },
    { region: "eu-central-1" },
  );
  let run;
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    run = await runs.retrieve(h.id);
    if (
      [
        "COMPLETED",
        "FAILED",
        "CRASHED",
        "SYSTEM_FAILURE",
        "CANCELED",
        "TIMED_OUT",
        "EXPIRED",
      ].includes(run.status)
    )
      break;
  }
  return run;
}
// baseline
let u = userLoop(pooler);
await sleep(20000);
await u.stop();
out.userBaseline = st(u.rec.map((r) => r.ms));
// laptop W1 + user
u = userLoop(pooler);
await sleep(1500);
const lw1 = await w1(pooler, 10);
await sleep(800);
await u.stop();
out.laptopW1 = analyse(lw1, u.rec);
out.laptopW1raw = lw1.map((h) => Math.round(h.holdMs));
// trigger W1 + user
u = userLoop(pooler);
await sleep(1500);
let run = await trig("w1");
await sleep(800);
await u.stop();
out.triggerStatus = run.status;
if (run.output) {
  out.triggerW1 = analyse(run.output.w1, u.rec);
  out.triggerW1raw = run.output.w1.map((h) => Math.round(h.holdMs));
}
// trigger W2 (no user loop)
run = await trig("w2");
out.triggerW2 = run.output?.w2 ?? run.error;
// laptop W2 again (no user loop), fresh
out.laptopW2 = await w2(pooler, 20);
fs.writeFileSync(`results2-${Date.now()}.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
```

### `lab-lock/setup.mjs`

```js
import fs from "fs";
import pg from "pg";
const env = fs.readFileSync("<path-to-env-file>", "utf8");
export const get = (k) => env.match(new RegExp(`^${k}="?([^"\\n]*)"?`, "m"))[1];
export const direct = get("DIRECT_URL");
export const pooler = get("DATABASE_URL").split("?")[0];
if (process.argv[2] === "setup") {
  const c = new pg.Client({
    connectionString: direct,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  await c.query("CREATE SCHEMA lab_lock");
  await c.query(
    "CREATE TABLE lab_lock.account(id int primary key, balance bigint, version int)",
  );
  await c.query(
    "INSERT INTO lab_lock.account VALUES (1,1000000,0),(2,500,0),(3,700,0),(4,900,0)",
  );
  console.log((await c.query("select count(*) from lab_lock.account")).rows[0]);
  await c.end();
}
```

### `lab-lock/trigger.config.ts`

```ts
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "<trigger-project-ref>",
  dirs: ["./src/trigger"],
  maxDuration: 300,
  retries: { enabled: false },
  build: { external: ["pg"] },
});
```

### `lab-lock/src/lock.mjs`

```js
import pg from "pg";
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const mk = (url) =>
  new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
const STMTS = [
  ["SELECT balance, version FROM lab_lock.account WHERE id=1"],
  ["SELECT count(*) FROM lab_lock.account"],
  ["SELECT balance FROM lab_lock.account WHERE id=2"],
  [
    "UPDATE lab_lock.account SET balance=balance-1, version=version+1 WHERE id=1 AND version=$1",
    "v",
  ],
  ["SELECT balance, version FROM lab_lock.account WHERE id=1"],
  ["SELECT sum(balance) FROM lab_lock.account"],
  ["SELECT balance FROM lab_lock.account WHERE id=3"],
  ["SELECT version FROM lab_lock.account WHERE id=1"],
];
// one txn; returns {holdMs, t0Epoch, t1Epoch}
export async function oneTxn(c, iso) {
  await c.query(iso ? `BEGIN ISOLATION LEVEL SERIALIZABLE` : "BEGIN");
  const e0 = Date.now(),
    t0 = now();
  let v, d0;
  const r = await c.query(
    `SELECT balance, version, extract(epoch from clock_timestamp())*1000 AS d FROM lab_lock.account WHERE id=1${iso ? "" : " FOR UPDATE"}`,
  );
  v = r.rows[0].version;
  d0 = Number(r.rows[0].d);
  let d1;
  for (const [sql, p] of STMTS) {
    const x = await c.query(sql, p ? [v] : undefined);
  }
  const l = await c.query(
    "SELECT extract(epoch from clock_timestamp())*1000 AS d",
  );
  d1 = Number(l.rows[0].d);
  await c.query("COMMIT");
  return {
    holdMs: now() - t0,
    t0Epoch: e0,
    t1Epoch: Date.now(),
    dbLockAt: d0,
    dbLastStmtAt: d1,
  };
}
export async function w1(url, n, gapMs = 400) {
  const c = mk(url);
  await c.connect();
  await c.query("SELECT 1");
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(await oneTxn(c, false));
    await sleep(gapMs);
  }
  await c.end();
  return out;
}
export async function w2(url, n) {
  const mkc = async () => {
    const c = mk(url);
    await c.connect();
    await c.query("SELECT 1");
    return c;
  };
  const cs = [await mkc(), await mkc()];
  const res = { ok: 0, fail40001: 0, otherErr: [] };
  for (let i = 0; i < n; i++) {
    await Promise.all(
      cs.map(async (c) => {
        try {
          await oneTxn(c, true);
          res.ok++;
        } catch (e) {
          try {
            await c.query("ROLLBACK");
          } catch {}
          if (e.code === "40001") res.fail40001++;
          else res.otherErr.push(String(e.code || e.message).slice(0, 60));
        }
      }),
    );
  }
  await Promise.all(cs.map((c) => c.end()));
  return res;
}
// laptop user loop: ~5/s autocommit updates until stop() ; records epoch + latency
export function userLoop(url) {
  let stop = false;
  const rec = [];
  const p = (async () => {
    const c = mk(url);
    await c.connect();
    await c.query("SELECT 1");
    while (!stop) {
      const e = Date.now(),
        t = now();
      const r = await c.query(
        "UPDATE lab_lock.account SET balance=balance+1 WHERE id=1 RETURNING extract(epoch from clock_timestamp())*1000 AS d",
      );
      rec.push({ e, ms: now() - t, dbAt: Number(r.rows[0].d) });
      await sleep(Math.max(0, 200 - (now() - t)));
    }
    await c.end();
  })();
  return {
    rec,
    stop: async () => {
      stop = true;
      await p;
    },
  };
}
```

### `lab-lock/src/trigger/lock.ts`

```ts
import { task } from "@trigger.dev/sdk";
import { w1, w2 } from "../lock.mjs";
export const lockProbe = task({
  id: "lock-probe",
  run: async (p: { mode: string }) => {
    const url = process.env.LOCK_DB_URL!;
    if (p.mode === "w2") return { w2: await w2(url, 20) };
    return { w1: await w1(url, 10) };
  },
});
```

## `lab-netlify/`

### `lab-netlify/netlify.toml`

```toml
[build]
  publish = "public"
[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"
  external_node_modules = ["pg"]
```

### `lab-netlify/package.json`

```json
{
  "name": "lab-netlify",
  "version": "1.0.0",
  "description": "",
  "main": "index.js",
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "type": "commonjs",
  "dependencies": {
    "@upstash/qstash": "^2.12.1",
    "@upstash/workflow": "^1.5.0",
    "inngest": "^4.26.2",
    "pg": "^8.23.1",
    "zod": "^4.6.7"
  }
}
```

### `lab-netlify/trig.mjs`

```js
import { Client } from "@upstash/workflow";
const c = new Client({
  baseUrl: "http://127.0.0.1:8080",
  token: "<qstash-dev-server-default-token>",
});
const name = process.argv[2];
console.log(new Date().toISOString(), "trigger", name);
const r = await c.trigger({
  url: `https://fw-probe-jobs-27089.netlify.app/api/wf/${name}`,
  body: {},
  retries: 0,
});
console.log(r);
```

### `lab-netlify/netlify/functions/db-probe.mjs`

```js
import pg from "pg";

const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const p95 = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
};
const now = () => performance.now();
const r1 = (x) => Math.round(x * 10) / 10;
let coldFlag = true; // module-level: true only on the first invocation of this container

export default async (req, context) => {
  const wasCold = coldFlag;
  coldFlag = false;
  const t0 = now();
  const out = {
    cold: wasCold,
    awsRegion: process.env.AWS_REGION,
    ctxRegion: context?.server?.region ?? null,
    node: process.version,
    pgVersion: pg.version ?? null,
  };
  const url = process.env.PROBE_DB_URL;
  const c = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  try {
    let t = now();
    await c.connect();
    out.connectMs = r1(now() - t);
    // SELECT 1 x50
    const s1 = [];
    for (let i = 0; i < 50; i++) {
      t = now();
      await c.query("SELECT 1");
      s1.push(now() - t);
    }
    out.select1 = {
      medianMs: r1(med(s1)),
      p95Ms: r1(p95(s1)),
      minMs: r1(Math.min(...s1)),
      maxMs: r1(Math.max(...s1)),
    };
    // 20-query mix
    const mix = [
      'SELECT id, "paymentStatus" FROM "Payment" ORDER BY "createdAt" DESC LIMIT 50',
      'SELECT id, "createdAt" FROM "Appointment" ORDER BY "createdAt" DESC LIMIT 50',
      'SELECT id, "jobName", status FROM "SystemJobExecution" ORDER BY "createdAt" DESC LIMIT 50',
      'SELECT count(*) FROM "Payment" WHERE "paymentStatus"::text = \'SUCCEEDED\'',
      'SELECT count(*) FROM "Appointment" WHERE "createdAt" > now() - interval \'90 days\'',
    ];
    t = now();
    for (let i = 0; i < 20; i++) await c.query(mix[i % 5]);
    out.mix20TotalMs = r1(now() - t);
    // lock-hold
    await c.query("CREATE SCHEMA IF NOT EXISTS lab_nlock");
    await c.query(
      "CREATE TABLE IF NOT EXISTS lab_nlock.account(id int primary key, balance bigint, version int)",
    );
    await c.query(
      "INSERT INTO lab_nlock.account VALUES (1,1000,0),(2,1000,0) ON CONFLICT DO NOTHING",
    );
    const holds = [];
    for (let i = 0; i < 10; i++) {
      t = now();
      await c.query("BEGIN");
      const r = await c.query(
        "SELECT id, balance, version FROM lab_nlock.account WHERE id=1 FOR UPDATE",
      );
      const v = r.rows[0].version;
      await c.query("SELECT balance FROM lab_nlock.account WHERE id=2");
      await c.query("SELECT count(*) FROM lab_nlock.account");
      await c.query(
        "UPDATE lab_nlock.account SET balance=balance+1, version=version+1 WHERE id=1 AND version=$1",
        [v],
      );
      await c.query(
        "UPDATE lab_nlock.account SET balance=balance-1 WHERE id=2",
      );
      await c.query("SELECT balance FROM lab_nlock.account WHERE id=1");
      await c.query("SELECT balance FROM lab_nlock.account WHERE id=2");
      await c.query("SELECT 1");
      await c.query("SELECT now()");
      await c.query("COMMIT");
      holds.push(now() - t);
    }
    out.lockHold = {
      medianMs: r1(med(holds)),
      p95Ms: r1(p95(holds)),
      rawMs: holds.map(r1),
    };
  } catch (e) {
    out.error = String(e.message).replace(/postgresql:\/\/\S+/g, "<url>");
  } finally {
    try {
      await c.end();
    } catch {}
  }
  out.totalMs = r1(now() - t0);
  return Response.json(out);
};
export const config = { path: "/api/db-probe" };
```

### `lab-netlify/netlify/functions/inngest.mjs`

```js
import pg from "pg";
import { Inngest } from "inngest";
import { serve } from "inngest/edge";

const inngest = new Inngest({ id: "lab-netlify" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const db = async () => {
  const c = new pg.Client({
    connectionString: process.env.PROBE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  return c;
};

const sweep = inngest.createFunction(
  { id: "sweep", triggers: [{ event: "lab/sweep" }] },
  async ({ step }) => {
    const ids = await step.run("read-batch", async () => {
      const t = Date.now();
      const c = await db();
      const t2 = Date.now();
      const r = await c.query(
        'SELECT id, "paymentStatus" FROM "Payment" ORDER BY "createdAt" DESC LIMIT 50',
      );
      await c.end();
      log(
        `[sweep] read-batch rows=${r.rowCount} connectMs=${t2 - t} totalMs=${Date.now() - t}`,
      );
      return r.rows.map((x) => x.id);
    });
    const n = await step.run("per-row", async () => {
      const t = Date.now();
      const c = await db();
      const t2 = Date.now();
      let k = 0;
      for (const id of ids.slice(0, 5)) {
        await c.query(
          'SELECT id, "paymentStatus", "createdAt" FROM "Payment" WHERE id=$1',
          [id],
        );
        k++;
      }
      await c.end();
      log(
        `[sweep] per-row rows=${k} connectMs=${t2 - t} totalMs=${Date.now() - t}`,
      );
      return k;
    });
    log(`[sweep] DONE batch=${ids.length} perRow=${n}`);
    return { batch: ids.length, perRow: n };
  },
);

const long30 = inngest.createFunction(
  { id: "long30", retries: 2, triggers: [{ event: "lab/long30" }] },
  async ({ step, attempt }) => {
    await step.run("long", async () => {
      log(`[long30] step start attempt=${attempt}`);
      await sleep(30000);
      log(`[long30] step END after 30s attempt=${attempt}`);
    });
    log("[long30] DONE");
  },
);

const ten5 = inngest.createFunction(
  { id: "ten5", retries: 1, triggers: [{ event: "lab/ten5" }] },
  async ({ step }) => {
    for (let n = 1; n <= 10; n++)
      await step.run(`t${n}`, async () => {
        log(`[ten5] step t${n} start`);
        await sleep(5000);
        log(`[ten5] step t${n} end`);
        return n;
      });
    log("[ten5] DONE");
  },
);

const handler = serve({ client: inngest, functions: [sweep, long30, ten5] });
export default async (req, context) => {
  const u = new URL(req.url);
  log(
    `REQ> ${req.method} ${u.search} reqid=${context.requestId} region=${process.env.AWS_REGION}`,
  );
  const res = await handler(req, context);
  log(
    `REQ< ${req.method} ${u.search} status=${res.status} reqid=${context.requestId}`,
  );
  return res;
};
export const config = { path: "/api/inngest" };
```

### `lab-netlify/netlify/functions/qs.mjs`

```js
import pg from "pg";
import { Client } from "@upstash/qstash";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const hdr = (req) =>
  `msg=${(req.headers.get("upstash-message-id") || "-").slice(0, 12)} retried=${req.headers.get("upstash-retried") ?? "-"} sched=${(req.headers.get("upstash-schedule-id") || "-").slice(0, 12)}`;

export default async (req, context) => {
  const path = new URL(req.url).pathname;
  if (path === "/api/qs-target") {
    log(`QS-TARGET start ${hdr(req)} reqid=${context.requestId}`);
    await sleep(30000);
    log(`QS-TARGET side-effect END ${hdr(req)} reqid=${context.requestId}`);
    return new Response("done");
  }
  if (path === "/api/qs-hit") {
    log(`QS-HIT ${hdr(req)} reqid=${context.requestId}`);
    return new Response("ok");
  }
  if (path === "/api/slow40") {
    log(`SLOW40 start reqid=${context.requestId}`);
    await sleep(40000);
    log(`SLOW40 END reqid=${context.requestId}`);
    return Response.json({ slow: true });
  }
  if (path === "/api/dual") {
    const fail = new URL(req.url).searchParams.get("fail") === "1";
    const id = Math.floor(Math.random() * 1e9);
    const c = new pg.Client({
      connectionString: process.env.PROBE_DB_URL,
      ssl: { rejectUnauthorized: false },
    });
    await c.connect();
    try {
      await c.query(
        "CREATE TABLE IF NOT EXISTS lab_nlock.dual_demo(id int primary key, note text)",
      );
      await c.query("INSERT INTO lab_nlock.dual_demo VALUES ($1,$2)", [
        id,
        fail ? "fail-case" : "ok-case",
      ]);
      log(`DUAL row ${id} inserted (committed), fail=${fail}`);
      if (fail)
        throw new Error("injected failure between DB write and publish");
      const q = new Client({
        baseUrl: process.env.QSTASH_URL,
        token: process.env.QSTASH_TOKEN,
      });
      const r = await q.publishJSON({
        url: `https://${new URL(req.url).host}/api/qs-hit`,
        body: { id },
      });
      log(`DUAL published ${r.messageId.slice(0, 12)}`);
      return Response.json({ id, published: true });
    } catch (e) {
      log(`DUAL error: ${e.message}`);
      return Response.json(
        { id, published: false, error: e.message },
        { status: 500 },
      );
    } finally {
      await c.end();
    }
  }
  return new Response("nf", { status: 404 });
};
export const config = {
  path: ["/api/qs-target", "/api/qs-hit", "/api/slow40", "/api/dual"],
};
```

### `lab-netlify/netlify/functions/wf.mjs`

```js
import { serve } from "@upstash/workflow/nextjs";

const log = (...a) => console.log(new Date().toISOString(), ...a);
const base = (req) => `https://${new URL(req.url).host}`;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

const routes = {
  wf3: async (ctx) => {
    log(`WF wf3 invoke runId=${ctx.workflowRunId.slice(0, 10)}`);
    const a = await ctx.run("s1", async () => {
      log("WF wf3 s1 body");
      return 1;
    });
    const b = await ctx.run("s2", async () => {
      log("WF wf3 s2 body");
      return a + 1;
    });
    await ctx.run("s3", async () => {
      log("WF wf3 s3 body");
      return b + 1;
    });
  },
  wflong: async (ctx) => {
    log(`WF wflong invoke`);
    await ctx.run("long", async () => {
      log("WF wflong step START");
      await sleepMs(30000);
      log("WF wflong step END after 30s");
    });
    await ctx.run("after", async () => {
      log("WF wflong after body");
    });
  },
  wfsleep: async (ctx) => {
    log(`WF wfsleep invoke`);
    await ctx.run("before", async () => {
      log("WF wfsleep before");
    });
    await ctx.sleep("nap", "10s");
    await ctx.run("after", async () => {
      log("WF wfsleep after");
    });
  },
  wfcall: async (ctx) => {
    log(`WF wfcall invoke`);
    const r = await ctx.call("slow", {
      url: `${process.env.WF_BASE_URL}/api/slow40`,
      method: "GET",
    });
    await ctx.run("after", async () => {
      log(`WF wfcall after status=${r.status}`);
    });
  },
};

const handlers = Object.fromEntries(
  Object.entries(routes).map(([k, fn]) => [
    k,
    serve(fn, { baseUrl: process.env.WF_BASE_URL, retries: 0 }).POST,
  ]),
);

export default async (req, context) => {
  const name = new URL(req.url).pathname.split("/").pop();
  const t = Date.now();
  log(
    `WFREQ> ${name} reqid=${context.requestId} callType=${req.headers.get("upstash-workflow-callType") ?? "-"}`,
  );
  const res = await handlers[name](req);
  log(
    `WFREQ< ${name} status=${res.status} took=${Date.now() - t}ms reqid=${context.requestId}`,
  );
  return res;
};
export const config = {
  path: ["/api/wf/wf3", "/api/wf/wflong", "/api/wf/wfsleep", "/api/wf/wfcall"],
};
```

## `lab-netlify-qstash/`

### `lab-netlify-qstash/cnt.mjs`

```js
import { env } from "./db.mjs";
let cursor = "",
  all = [];
for (let p = 0; p < 15; p++) {
  const r = await (
    await fetch(
      `${env.QSTASH_URL}/v2/events?count=100${cursor ? "&cursor=" + cursor : ""}`,
      { headers: { Authorization: "Bearer " + env.QSTASH_TOKEN } },
    )
  ).json();
  all.push(...(r.events || []));
  cursor = r.cursor;
  if (!cursor || !(r.events || []).length) break;
}
const mine = all
  .filter((e) => e.time > 1793446681000 && e.time < 1793446740000)
  .filter(
    (e) =>
      e.url.includes("fw-probe-jobs-9651") && e.path.startsWith("/api/wf/"),
  );
const m = {};
for (const e of mine) {
  const k = e.path + " " + e.state + " " + (e.responseStatus ?? "");
  m[k] = (m[k] || 0) + 1;
}
console.log(
  [
    ...new Set(
      all
        .filter((e) => e.time > 1793446681000 && e.time < 1793446740000)
        .map((e) => e.host + e.path + " " + e.state),
    ),
  ].join("\n"),
);
console.log(
  all.length,
  new Date(all[0].time).toISOString(),
  new Date(all.at(-1).time).toISOString(),
  m,
);
for (const e of mine.filter((e) => e.state === "DELIVERED").reverse())
  console.log(
    new Date(e.time).toISOString().slice(11, 23),
    e.path,
    e.duration + "ms",
  );
```

### `lab-netlify-qstash/db.mjs`

```js
import fs from "fs";
import pg from "pg";
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => /^(QSTASH_|PROBE_|WF_)/.test(k)),
); // credentials come from the environment only
export const connect = async () => {
  const c = new pg.Client({
    connectionString: env.PROBE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  return c;
};
export { env };
```

### `lab-netlify-qstash/ev.mjs`

```js
import { env } from "./db.mjs";
const id = process.argv[2];
let cursor = "";
const out = [];
for (let p = 0; p < 6; p++) {
  const r = await (
    await fetch(
      `${env.QSTASH_URL}/v2/events?count=100${cursor ? "&cursor=" + cursor : ""}${id && id.startsWith("msg_") ? "&messageId=" + id : ""}`,
      { headers: { Authorization: "Bearer " + env.QSTASH_TOKEN } },
    )
  ).json();
  out.push(...r.events);
  cursor = r.cursor;
  if (!cursor) break;
}
const ev = out.filter((e) => !id || e.messageId === id).reverse();
const t0 = ev[0]?.time;
for (const e of ev)
  console.log(
    new Date(e.time).toISOString(),
    "+" + ((e.time - t0) / 1000).toFixed(1) + "s",
    e.state,
    e.responseStatus ?? "",
    e.duration ?? "",
    e.nextDeliveryTime
      ? "next=+" + ((e.nextDeliveryTime - t0) / 1000).toFixed(1)
      : "",
    (e.error || e.responseBody || "").slice(0, 100),
  );
```

### `lab-netlify-qstash/netlify.toml`

```toml
[build]
  publish = "public"
[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"
  external_node_modules = ["pg"]
```

### `lab-netlify-qstash/package.json`

```json
{
  "name": "lab-netlify-qstash",
  "version": "1.0.0",
  "type": "commonjs",
  "dependencies": {
    "@upstash/qstash": "2.12.1",
    "@upstash/workflow": "1.5.0",
    "pg": "^8.23.1"
  }
}
```

### `lab-netlify-qstash/setup.mjs`

```js
import { connect } from "./db.mjs";
const c = await connect();
await c.query("CREATE SCHEMA IF NOT EXISTS lab_nq");
await c.query(
  "CREATE TABLE IF NOT EXISTS lab_nq.events(id serial primary key, kind text, msg_id text, retried int, schedule_id text, sent_ms bigint, recv_ms bigint, note text)",
);
console.log(
  (
    await c.query("select nspname from pg_namespace where nspname like 'lab_%'")
  ).rows.map((r) => r.nspname),
);
await c.end();
```

### `lab-netlify-qstash/t1.mjs`

```js
import { Client } from "@upstash/qstash";
import { env, connect } from "./db.mjs";
const q = new Client({ baseUrl: env.QSTASH_URL, token: env.QSTASH_TOKEN });
const T = "https://fw-probe-jobs-9651.netlify.app";
const pubs = [];
for (let i = 0; i < 20; i++) {
  const sent = Date.now();
  const r = await q.publishJSON({
    url: `${T}/api/receive?k=t1`,
    body: { sent, i },
  });
  pubs.push({ i, id: r.messageId, apiMs: Date.now() - sent, sent });
  await new Promise((r) => setTimeout(r, 2000));
}
await new Promise((r) => setTimeout(r, 8000));
const c = await connect();
const rows = (
  await c.query(
    "select msg_id, retried, sent_ms, recv_ms from lab_nq.events where kind='t1' order by id",
  )
).rows;
await c.end();
const lat = rows.map((r) => Number(r.recv_ms) - Number(r.sent_ms));
const s = [...lat].sort((a, b) => a - b);
console.log("n", rows.length, "lat ms", lat.join(","));
console.log(
  "median",
  (s[9] + s[10]) / 2,
  "p95",
  s[18],
  "min",
  s[0],
  "max",
  s[19],
);
const a = pubs.map((p) => p.apiMs).sort((x, y) => x - y);
console.log("publish api ms median", a[10], "min", a[0], "max", a[19]);
console.log("ids", pubs.map((p) => p.id).join(" "));
```

### `lab-netlify-qstash/t2.mjs`

```js
import { Client } from "@upstash/qstash";
import { env } from "./db.mjs";
const q = new Client({ baseUrl: env.QSTASH_URL, token: env.QSTASH_TOKEN });
const r = await q.publishJSON({
  url: "https://fw-probe-jobs-9651.netlify.app/api/long",
  body: { t: Date.now() },
});
console.log(r.messageId, new Date().toISOString());
```

### `lab-netlify-qstash/t3.mjs`

```js
import { Client } from "@upstash/qstash";
import { env, connect } from "./db.mjs";
const q = new Client({ baseUrl: env.QSTASH_URL, token: env.QSTASH_TOKEN });
const T = "https://fw-probe-jobs-9651.netlify.app";
const sd = await q.schedules.create({
  destination: `${T}/api/receive?k=sched`,
  cron: "* * * * *",
  body: JSON.stringify({ s: 1 }),
  headers: { "Content-Type": "application/json" },
});
console.log("schedule", sd.scheduleId, new Date().toISOString());
const dl = [];
for (let i = 0; i < 3; i++) {
  const sent = Date.now();
  const r = await q.publishJSON({
    url: `${T}/api/receive?k=delay`,
    body: { sent },
    delay: 30,
  });
  dl.push({ id: r.messageId, due: sent + 30000, sent });
  console.log("delayed", r.messageId, sent);
  await new Promise((r) => setTimeout(r, 15000));
}
await new Promise((r) => setTimeout(r, 190000 - 45000));
const c = await connect();
const rows = (
  await c.query(
    "select kind,msg_id,sent_ms,recv_ms,schedule_id,retried from lab_nq.events where kind in ('delay','sched') order by id",
  )
).rows;
await c.end();
for (const r of rows.filter((r) => r.kind === "delay"))
  console.log(
    "delay lateness ms",
    Number(r.recv_ms) - (Number(r.sent_ms) + 30000),
    "(vs publish-ts+30s)",
  );
for (const r of rows.filter((r) => r.kind === "sched")) {
  const t = Number(r.recv_ms);
  console.log(
    "sched",
    new Date(t).toISOString(),
    "lateness after minute boundary ms",
    t % 60000,
  );
}
console.log("sched total", rows.filter((r) => r.kind === "sched").length);
console.log(JSON.stringify({ sd: sd.scheduleId, dl }));
```

### `lab-netlify-qstash/t4.mjs`

```js
import { Client } from "@upstash/workflow";
import { env } from "./db.mjs";
const c = new Client({ baseUrl: env.QSTASH_URL, token: env.QSTASH_TOKEN });
const T = "https://fw-probe-jobs-9651.netlify.app";
const a = await c.trigger({
  url: `${T}/api/wf/wf3`,
  body: "x",
  workflowRunId: "nq-wf3-" + Date.now(),
});
const b = await c.trigger({
  url: `${T}/api/wf/wfsleep`,
  body: "x",
  workflowRunId: "nq-wfsleep-" + Date.now(),
});
console.log(JSON.stringify([a, b]));
```

### `lab-netlify-qstash/netlify/functions/lab.mjs`

```js
import pg from "pg";
import { Receiver } from "@upstash/qstash";
import { serve } from "@upstash/workflow/nextjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const db = async () => {
  const c = new pg.Client({
    connectionString: process.env.PROBE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  return c;
};
async function rec(kind, req, extra = {}) {
  const c = await db();
  try {
    await c.query(
      "INSERT INTO lab_nq.events(kind,msg_id,retried,schedule_id,sent_ms,recv_ms,note) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [
        kind,
        req.headers.get("upstash-message-id"),
        Number(req.headers.get("upstash-retried") ?? 0),
        req.headers.get("upstash-schedule-id"),
        extra.sent ?? null,
        Date.now(),
        extra.note ?? null,
      ],
    );
  } finally {
    await c.end();
  }
}
const receiver = () =>
  new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
  });
// Receiver.verify throws SignatureError on an invalid signature: an unsigned request returned 500 and wrote no row.
async function verified(req) {
  const body = await req.text();
  await receiver().verify({
    signature: req.headers.get("upstash-signature"),
    body,
    url: req.url,
  });
  return body;
}
const base = () => process.env.WF_BASE_URL;
const wfRoutes = {
  wf3: async (ctx) => {
    await rec(
      "wf_req",
      ctx.headers ? { headers: new Headers() } : { headers: new Headers() },
      { note: "wf3 invoke " + ctx.workflowRunId },
    );
    const a = await ctx.run("s1", async () => {
      await rec("wf_step", { headers: new Headers() }, { note: "wf3 s1" });
      return 1;
    });
    const b = await ctx.run("s2", async () => {
      await rec("wf_step", { headers: new Headers() }, { note: "wf3 s2" });
      return a + 1;
    });
    await ctx.run("s3", async () => {
      await rec("wf_step", { headers: new Headers() }, { note: "wf3 s3" });
      return b + 1;
    });
  },
  wfsleep: async (ctx) => {
    await rec(
      "wf_req",
      { headers: new Headers() },
      { note: "wfsleep invoke " + ctx.workflowRunId },
    );
    await ctx.run("before", async () => {
      await rec(
        "wf_step",
        { headers: new Headers() },
        { note: "wfsleep before" },
      );
    });
    await ctx.sleep("nap", "10s");
    await ctx.run("after", async () => {
      await rec(
        "wf_step",
        { headers: new Headers() },
        { note: "wfsleep after" },
      );
    });
  },
};
const wfh = Object.fromEntries(
  Object.entries(wfRoutes).map(([k, fn]) => [
    k,
    serve(fn, { baseUrl: base() }),
  ]),
);

export default async (req, context) => {
  const url = new URL(req.url);
  const p = url.pathname;
  try {
    if (p.startsWith("/api/wf/")) {
      const n = p.split("/").pop();
      log(`WFREQ ${n} reqid=${context.requestId}`);
      await rec("wf_http", req, { note: n });
      const res = await wfh[n].POST(req);
      log(`WFRES ${n} status=${res.status}`);
      return res;
    }
    const body = await verified(req);
    const k = url.searchParams.get("k") || "recv";
    if (p === "/api/receive") {
      let sent = null;
      try {
        sent = JSON.parse(body).sent ?? null;
      } catch {}
      await rec(k, req, { sent });
      log(
        `RECV k=${k} msg=${req.headers.get("upstash-message-id")} retried=${req.headers.get("upstash-retried")}`,
      );
      return new Response("ok");
    }
    if (p === "/api/long") {
      log(
        `LONG start retried=${req.headers.get("upstash-retried")} reqid=${context.requestId}`,
      );
      await rec("long_start", req);
      await sleep(30000);
      await rec("long_effect", req);
      log(`LONG effect written retried=${req.headers.get("upstash-retried")}`);
      return new Response("done");
    }
  } catch (e) {
    log("ERR", e.message);
    return new Response("err " + e.message, { status: 500 });
  }
  return new Response("nf", { status: 404 });
};
export const config = {
  path: ["/api/receive", "/api/long", "/api/wf/wf3", "/api/wf/wfsleep"],
};
```

## `lab-vercel/`

### `lab-vercel/package.json`

```json
{
  "name": "lab-vercel-probe",
  "version": "1.0.0",
  "private": true,
  "dependencies": { "pg": "^8.13.0" }
}
```

### `lab-vercel/vercel.json`

```json
{
  "regions": ["bom1"],
  "functions": {
    "api/long.js": { "maxDuration": 300 },
    "api/db-probe.js": { "maxDuration": 60 }
  }
}
```

### `lab-vercel/api/db-probe.js`

```js
const { Client } = require("pg");
const now = () => Number(process.hrtime.bigint()) / 1e6;
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};
const r = (x) => Math.round(x * 100) / 100;

module.exports = async (req, res) => {
  const t0 = now();
  const url = new URL(process.env.DATABASE_URL);
  url.search = "";
  const c = new Client({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
  });
  const out = { region: process.env.VERCEL_REGION, node: process.version };
  try {
    let t = now();
    await c.connect();
    out.connect_ms = r(now() - t);

    const s1 = [];
    for (let i = 0; i < 50; i++) {
      t = now();
      await c.query("SELECT 1");
      s1.push(now() - t);
    }
    out.select1 = { median_ms: r(pct(s1, 0.5)), p95_ms: r(pct(s1, 0.95)) };

    const qs = [
      'SELECT id, "paymentStatus" FROM "Payment" ORDER BY "createdAt" DESC LIMIT 50',
      'SELECT id, "createdAt" FROM "Appointment" ORDER BY "createdAt" DESC LIMIT 50',
      'SELECT id, status FROM "SystemJobExecution" ORDER BY "createdAt" DESC LIMIT 50',
      `SELECT count(*) FROM "Payment" WHERE "paymentStatus"::text = 'SUCCEEDED'`,
      `SELECT count(*) FROM "SystemJobExecution" WHERE status::text = 'SUCCEEDED'`,
    ];
    t = now();
    for (let i = 0; i < 20; i++) await c.query(qs[i % qs.length]);
    out.mix20_total_ms = r(now() - t);

    await c.query("CREATE SCHEMA IF NOT EXISTS lab_vlock");
    await c.query(
      "CREATE TABLE IF NOT EXISTS lab_vlock.account(id int primary key, balance bigint, version int)",
    );
    await c.query(
      "INSERT INTO lab_vlock.account VALUES (1,1000,0) ON CONFLICT DO NOTHING",
    );
    const holds = [];
    for (let i = 0; i < 10; i++) {
      await c.query("BEGIN");
      const row = (
        await c.query(
          "SELECT balance, version FROM lab_vlock.account WHERE id=1 FOR UPDATE",
        )
      ).rows[0];
      t = now();
      await c.query("SELECT 1");
      await c.query("SELECT count(*) FROM lab_vlock.account");
      await c.query("SELECT balance FROM lab_vlock.account WHERE id=1");
      const u = await c.query(
        "UPDATE lab_vlock.account SET balance=balance+1, version=version+1 WHERE id=1 AND version=$1",
        [row.version],
      );
      if (u.rowCount !== 1) throw new Error("CAS failed");
      await c.query("SELECT version FROM lab_vlock.account WHERE id=1");
      await c.query("SELECT 1");
      await c.query("SELECT now()");
      await c.query("SELECT balance FROM lab_vlock.account WHERE id=1");
      await c.query("COMMIT");
      holds.push(now() - t);
    }
    out.lock_hold = {
      median_ms: r(pct(holds, 0.5)),
      p95_ms: r(pct(holds, 0.95)),
      all_ms: holds.map(r),
    };
  } catch (e) {
    out.error = String(e.message).slice(0, 200);
    try {
      await c.query("ROLLBACK");
    } catch {}
  } finally {
    try {
      await c.end();
    } catch {}
  }
  out.total_ms = r(now() - t0);
  res.status(200).json(out);
};
```

### `lab-vercel/api/long.js`

```js
module.exports = async (req, res) => {
  const n = Number(req.query.n || 1);
  await new Promise((r) => setTimeout(r, n * 1000));
  res.status(200).json({ slept: n, region: process.env.VERCEL_REGION });
};
```

## `lab-vercel2/`

### `lab-vercel2/fluid-off/package.json`

```json
{
  "name": "fw-lab-fluid-off",
  "version": "1.0.0",
  "private": true,
  "dependencies": { "pg": "^8.13.0" }
}
```

### `lab-vercel2/fluid-off/vercel.json`

```json
{ "regions": ["bom1"], "fluid": false }
```

### `lab-vercel2/fluid-off/api/work.js`

```js
const { Pool } = require("pg");
const crypto = require("crypto");
const now = () => Number(process.hrtime.bigint()) / 1e6;
const r = (x) => Math.round(x * 100) / 100;

const instanceId = crypto.randomUUID();
const bootedAt = Date.now();
let coldStart = true;
let served = 0;
let inflight = 0;
let maxInflight = 0;

const url = new URL(process.env.DATABASE_URL);
url.search = "";
const pool = new Pool({
  connectionString: url.toString(),
  ssl: { rejectUnauthorized: false },
  max: 5,
  application_name: process.env.LAB_APP,
});

module.exports = async (req, res) => {
  const t0 = now();
  const wasCold = coldStart;
  coldStart = false;
  served += 1;
  inflight += 1;
  maxInflight = Math.max(maxInflight, inflight);
  const out = {
    instanceId,
    coldStart: wasCold,
    region: process.env.VERCEL_REGION,
    servedOnInstance: served,
    inflightAtStart: inflight,
  };
  try {
    const q = [];
    for (let i = 0; i < 10; i++) {
      const t = now();
      await pool.query("select $1::int as n", [i]);
      q.push(now() - t);
    }
    const t = now();
    await pool.query("select pg_sleep(0.3)");
    out.sleepMs = r(now() - t);
    out.queryMs = q.map(r);
    out.poolTotal = pool.totalCount;
  } catch (e) {
    out.error = String(e.message).slice(0, 200);
  } finally {
    inflight -= 1;
  }
  out.maxInflightOnInstance = maxInflight;
  out.instanceAgeMs = Date.now() - bootedAt;
  out.fnMs = r(now() - t0);
  res.status(out.error ? 500 : 200).json(out);
};
```

### `lab-vercel2/fluid-on/package.json`

```json
{
  "name": "fw-lab-fluid-on",
  "version": "1.0.0",
  "private": true,
  "dependencies": { "pg": "^8.13.0" }
}
```

### `lab-vercel2/fluid-on/vercel.json`

```json
{ "regions": ["bom1"], "fluid": true }
```

### `lab-vercel2/fluid-on/api/work.js`

```js
const { Pool } = require("pg");
const crypto = require("crypto");
const now = () => Number(process.hrtime.bigint()) / 1e6;
const r = (x) => Math.round(x * 100) / 100;

const instanceId = crypto.randomUUID();
const bootedAt = Date.now();
let coldStart = true;
let served = 0;
let inflight = 0;
let maxInflight = 0;

const url = new URL(process.env.DATABASE_URL);
url.search = "";
const pool = new Pool({
  connectionString: url.toString(),
  ssl: { rejectUnauthorized: false },
  max: 5,
  application_name: process.env.LAB_APP,
});

module.exports = async (req, res) => {
  const t0 = now();
  const wasCold = coldStart;
  coldStart = false;
  served += 1;
  inflight += 1;
  maxInflight = Math.max(maxInflight, inflight);
  const out = {
    instanceId,
    coldStart: wasCold,
    region: process.env.VERCEL_REGION,
    servedOnInstance: served,
    inflightAtStart: inflight,
  };
  try {
    const q = [];
    for (let i = 0; i < 10; i++) {
      const t = now();
      await pool.query("select $1::int as n", [i]);
      q.push(now() - t);
    }
    const t = now();
    await pool.query("select pg_sleep(0.3)");
    out.sleepMs = r(now() - t);
    out.queryMs = q.map(r);
    out.poolTotal = pool.totalCount;
  } catch (e) {
    out.error = String(e.message).slice(0, 200);
  } finally {
    inflight -= 1;
  }
  out.maxInflightOnInstance = maxInflight;
  out.instanceAgeMs = Date.now() - bootedAt;
  out.fnMs = r(now() - t0);
  res.status(out.error ? 500 : 200).json(out);
};
```

### `lab-vercel2/qs/package.json`

```json
{
  "name": "fw-lab-qs",
  "version": "1.0.0",
  "private": true,
  "scripts": { "postinstall": "prisma generate" },
  "dependencies": {
    "pg": "^8.13.0",
    "@upstash/qstash": "2.12.1",
    "@upstash/workflow": "1.5.0",
    "@prisma/client": "7.10.0",
    "@prisma/adapter-pg": "7.10.0",
    "prisma": "7.10.0"
  }
}
```

### `lab-vercel2/qs/prisma.config.ts`

```ts
import { defineConfig } from "prisma/config";
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url:
      process.env.DATABASE_URL ||
      "postgresql://placeholder:placeholder@localhost:5432/placeholder",
  },
});
```

### `lab-vercel2/qs/vercel.json`

```json
{
  "regions": ["bom1"],
  "functions": {
    "api/*.js": { "maxDuration": 300 },
    "api/*.mjs": { "maxDuration": 300 }
  }
}
```

### `lab-vercel2/qs/api/db-probe.js`

```js
const { Client } = require("pg");
const { run, now, r } = require("../lib/workload");
const { init, url } = require("../lib/db");
module.exports = async (req, res) => {
  await init();
  const c = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  const out = { impl: "raw-pg", region: process.env.VERCEL_REGION };
  let t = now();
  await c.connect();
  out.connect_ms = r(now() - t);
  await c.query("SELECT 1");
  const q = async (sql, p, count) => {
    const x = await c.query(sql, p);
    return count ? x.rowCount : x.rows;
  };
  const tx = async (fn) => {
    await c.query("BEGIN");
    try {
      await fn(q);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  };
  try {
    Object.assign(out, await run(q, tx));
  } catch (e) {
    out.error = e.message.slice(0, 200);
  }
  await c.end();
  res.json(out);
};
```

### `lab-vercel2/qs/api/dualwrite.js`

```js
const { Client } = require("@upstash/qstash");
const { pool, init, ev } = require("../lib/db");
module.exports = async (req, res) => {
  await init();
  const id = req.query.id || `o-${Date.now()}`;
  const fail = req.query.fail === "1";
  const out = { id };
  await pool.query("INSERT INTO lab_v2lock.orders(id) VALUES ($1)", [id]); // step 1: committed
  out.rowCommitted = true;
  try {
    if (fail) throw new Error("injected failure before publish");
    const q = new Client({
      baseUrl: process.env.QSTASH_URL,
      token: process.env.QSTASH_TOKEN,
    });
    const r = await q.publish({
      url: `https://${req.headers.host}/api/receive?tag=dual`,
      body: JSON.stringify({ id, sentAt: Date.now() }),
      headers: { "Content-Type": "text/plain" },
    });
    out.messageId = r.messageId;
  } catch (e) {
    out.publishError = e.message;
    res.status(500);
  }
  await ev("dual", id, out);
  res.json(out);
};
```

### `lab-vercel2/qs/api/long.js`

```js
const { ev } = require("../lib/db");
module.exports = async (req, res) => {
  const s = Number(req.query.s || 1);
  const key = req.query.k || `s${s}`;
  const meta = {
    msgId: req.headers["upstash-message-id"],
    retried: req.headers["upstash-retried"],
    s,
  };
  await ev("long_start", key, meta);
  await new Promise((r) => setTimeout(r, s * 1000));
  await ev("long_end", key, meta);
  res.status(200).json({ done: true, s });
};
```

### `lab-vercel2/qs/api/prisma.js`

```js
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { run, now, r } = require("../lib/workload");
const { init, url } = require("../lib/db");
let prisma;
module.exports = async (req, res) => {
  await init();
  const out = {
    impl: "prisma-7.10-adapter-pg",
    region: process.env.VERCEL_REGION,
    cold: !prisma,
  };
  let t = now();
  if (!prisma)
    prisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: url,
        max: 1,
        ssl: { rejectUnauthorized: false },
      }),
    });
  out.client_ctor_ms = r(now() - t);
  t = now();
  await prisma.$queryRaw`SELECT 1`;
  out.first_query_ms = r(now() - t);
  const mk = (db) => async (sql, p, count) =>
    count ? db.$executeRawUnsafe(sql) : db.$queryRawUnsafe(sql);
  const q = mk(prisma);
  const tx = (fn) => prisma.$transaction(async (t2) => fn(mk(t2)));
  try {
    Object.assign(out, await run(q, tx));
  } catch (e) {
    out.error = e.message.slice(0, 300);
  }
  res.json(out);
};
```

### `lab-vercel2/qs/api/receive.js`

```js
const { Receiver } = require("@upstash/qstash");
const { ev } = require("../lib/db");
const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
});
module.exports = async (req, res) => {
  const recvAt = Date.now();
  const body =
    typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? "");
  let ok = false;
  try {
    ok = await receiver.verify({
      signature: req.headers["upstash-signature"],
      body,
    });
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    await ev("recv_badsig", "-", { recvAt });
    return res.status(401).json({ ok: false });
  }
  let parsed = {};
  try {
    parsed = JSON.parse(body);
  } catch {}
  const tag = req.query.tag || "msg";
  await ev("recv", String(parsed.id ?? req.headers["upstash-message-id"]), {
    tag,
    sentAt: parsed.sentAt,
    recvAt,
    msgId: req.headers["upstash-message-id"],
    retried: req.headers["upstash-retried"],
    scheduleId: req.headers["upstash-schedule-id"],
    region: process.env.VERCEL_REGION,
  });
  res.status(200).json({ ok: true, recvAt });
};
```

### `lab-vercel2/qs/api/wf-call290.mjs`

```js
import { serve } from "@upstash/workflow";
import db from "../lib/db.js";
const { ev } = db;
const NAME = "call290";
const { handler } = serve(
  async (context) => {
    const rid = context.workflowRunId;
    await context.run("before", async () => {
      await ev("wf_step", rid, { name: NAME, phase: "before" });
    });
    const res = await context.call("long", {
      url: process.env.WF_BASE + "/api/long?s=290&k=wf290",
      method: "GET",
      retries: 0,
    });
    await context.run("after", async () => {
      await ev("wf_step", rid, {
        name: NAME,
        phase: "after",
        status: res.status,
      });
    });
  },
  { baseUrl: process.env.WF_BASE },
);
export default {
  async fetch(req) {
    await ev("wf_http", NAME, { t: Date.now() });
    return handler(req);
  },
};
```

### `lab-vercel2/qs/api/wf-call400.mjs`

```js
import { serve } from "@upstash/workflow";
import db from "../lib/db.js";
const { ev } = db;
const NAME = "call400";
const { handler } = serve(
  async (context) => {
    const rid = context.workflowRunId;
    await context.run("before", async () => {
      await ev("wf_step", rid, { name: NAME, phase: "before" });
    });
    const res = await context.call("long", {
      url: process.env.WF_BASE + "/api/long?s=400&k=wf400",
      method: "GET",
      retries: 0,
    });
    await context.run("after", async () => {
      await ev("wf_step", rid, {
        name: NAME,
        phase: "after",
        status: res.status,
      });
    });
  },
  { baseUrl: process.env.WF_BASE },
);
export default {
  async fetch(req) {
    await ev("wf_http", NAME, { t: Date.now() });
    return handler(req);
  },
};
```

### `lab-vercel2/qs/api/wf-sleep.mjs`

```js
import { serve } from "@upstash/workflow";
import db from "../lib/db.js";
const { ev } = db;
const NAME = "sleep";
const { handler } = serve(
  async (context) => {
    const rid = context.workflowRunId;
    await context.run("before", async () => {
      await ev("wf_step", rid, { name: NAME, phase: "before" });
    });
    await context.sleep("nap", "10s");
    await context.run("after", async () => {
      await ev("wf_step", rid, { name: NAME, phase: "after" });
    });
  },
  { baseUrl: process.env.WF_BASE },
);
export default {
  async fetch(req) {
    await ev("wf_http", NAME, { t: Date.now() });
    return handler(req);
  },
};
```

### `lab-vercel2/qs/api/wf-slow30.mjs`

```js
import { serve } from "@upstash/workflow";
import db from "../lib/db.js";
const { ev } = db;
const NAME = "slow30";
const { handler } = serve(
  async (context) => {
    const rid = context.workflowRunId;
    await context.run("slow", async () => {
      await ev("wf_step", rid, { name: NAME, phase: "start" });
      await new Promise((r) => setTimeout(r, 30000));
      await ev("wf_step", rid, { name: NAME, phase: "end" });
      return 1;
    });
  },
  { baseUrl: process.env.WF_BASE },
);
export default {
  async fetch(req) {
    await ev("wf_http", NAME, { t: Date.now() });
    return handler(req);
  },
};
```

### `lab-vercel2/qs/api/wf-three.mjs`

```js
import { serve } from "@upstash/workflow";
import db from "../lib/db.js";
const { ev } = db;
const NAME = "three";
const { handler } = serve(
  async (context) => {
    const rid = context.workflowRunId;
    await context.run("s1", async () => {
      await ev("wf_step", rid, { name: NAME, step: 1 });
      return 1;
    });
    await context.run("s2", async () => {
      await ev("wf_step", rid, { name: NAME, step: 2 });
      return 2;
    });
    await context.run("s3", async () => {
      await ev("wf_step", rid, { name: NAME, step: 3 });
      return 3;
    });
  },
  { baseUrl: process.env.WF_BASE },
);
export default {
  async fetch(req) {
    await ev("wf_http", NAME, { t: Date.now() });
    return handler(req);
  },
};
```

### `lab-vercel2/qs/lib/db.js`

```js
const { Pool } = require("pg");
const url = new URL(process.env.DATABASE_URL);
url.search = "";
const pool = new Pool({
  connectionString: url.toString(),
  ssl: { rejectUnauthorized: false },
  max: 3,
  application_name: "fw-lab-qs",
});
let ready = null;
function init() {
  if (!ready)
    ready = (async () => {
      await pool.query("CREATE SCHEMA IF NOT EXISTS lab_v2lock");
      await pool.query(
        "CREATE TABLE IF NOT EXISTS lab_v2lock.events(id bigserial primary key, kind text, key text, at timestamptz not null default clock_timestamp(), data jsonb)",
      );
      await pool.query(
        "CREATE TABLE IF NOT EXISTS lab_v2lock.account(id int primary key, balance bigint, version int)",
      );
      await pool.query(
        "INSERT INTO lab_v2lock.account VALUES (1,1000,0) ON CONFLICT DO NOTHING",
      );
      await pool.query(
        "CREATE TABLE IF NOT EXISTS lab_v2lock.orders(id text primary key, created_at timestamptz default now())",
      );
    })();
  return ready;
}
async function ev(kind, key, data) {
  await init();
  await pool.query(
    "INSERT INTO lab_v2lock.events(kind,key,data) VALUES ($1,$2,$3)",
    [kind, key, JSON.stringify(data || {})],
  );
}
module.exports = { pool, init, ev, url: url.toString() };
```

### `lab-vercel2/qs/lib/workload.js`

```js
const now = () => Number(process.hrtime.bigint()) / 1e6;
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};
const r = (x) => Math.round(x * 100) / 100;
const qs = [
  'SELECT id, "paymentStatus" FROM "Payment" ORDER BY "createdAt" DESC LIMIT 50',
  'SELECT id, "createdAt" FROM "Appointment" ORDER BY "createdAt" DESC LIMIT 50',
  'SELECT id, status FROM "SystemJobExecution" ORDER BY "createdAt" DESC LIMIT 50',
  `SELECT count(*) FROM "Payment" WHERE "paymentStatus"::text = 'SUCCEEDED'`,
  `SELECT count(*) FROM "SystemJobExecution" WHERE status::text = 'SUCCEEDED'`,
];
// q(sql, params) runs one statement; tx(fn) runs fn(q) inside BEGIN..COMMIT and resolves after COMMIT.
async function run(q, tx) {
  const out = {};
  const s1 = [];
  for (let i = 0; i < 50; i++) {
    const t = now();
    await q("SELECT 1");
    s1.push(now() - t);
  }
  out.select1 = { median_ms: r(pct(s1, 0.5)), p95_ms: r(pct(s1, 0.95)) };
  let t = now();
  for (let i = 0; i < 20; i++) await q(qs[i % qs.length]);
  out.mix20_total_ms = r(now() - t);
  const holds = [];
  for (let i = 0; i < 10; i++) {
    let start;
    await tx(async (q) => {
      const row = (
        await q(
          "SELECT balance, version FROM lab_v2lock.account WHERE id=1 FOR UPDATE",
        )
      )[0];
      start = now();
      await q("SELECT 1");
      await q("SELECT count(*) FROM lab_v2lock.account");
      await q("SELECT balance FROM lab_v2lock.account WHERE id=1");
      const n = await q(
        "UPDATE lab_v2lock.account SET balance=balance+1, version=version+1 WHERE id=1 AND version=" +
          Number(row.version),
        null,
        true,
      );
      if (n !== 1) throw new Error("CAS failed");
      await q("SELECT version FROM lab_v2lock.account WHERE id=1");
      await q("SELECT 1");
      await q("SELECT now()");
      await q("SELECT balance FROM lab_v2lock.account WHERE id=1");
    });
    holds.push(now() - start);
  }
  out.lock_hold = {
    median_ms: r(pct(holds, 0.5)),
    p95_ms: r(pct(holds, 0.95)),
  };
  return out;
}
module.exports = { run, now, r };
```

### `lab-vercel2/tools/ev.js`

```js
const { Client } = require("pg");
const fs = require("fs");
const env = fs
  .readFileSync("<path-to-env-file>", "utf8")
  .split("\n")
  .find((l) => l.startsWith("DATABASE_URL="));
const u = new URL(env.slice(13).replace(/^"|"$/g, ""));
u.search = "";
(async () => {
  const c = new Client({
    connectionString: u.toString(),
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  const r = await c.query(process.argv[2]);
  console.log(JSON.stringify(r.rows));
  await c.end();
})();
```

### `lab-vercel2/tools/load.js`

```js
// usage: node load.js <project> <label> <concurrency> <rounds-of-bursts>   (concurrency 1 => sequential series of N)
const [proj, label, conc, n] = process.argv.slice(2);
const base = `https://${proj}.vercel.app/api/work`;
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};
(async () => {
  const total = Number(n);
  const lat = [];
  const res = [];
  let errors = 0;
  const one = async () => {
    const t = performance.now();
    try {
      const r = await fetch(base);
      const j = await r.json().catch(() => ({}));
      lat.push(performance.now() - t);
      if (r.status !== 200) errors++;
      res.push({ status: r.status, ...j });
    } catch (e) {
      errors++;
      lat.push(performance.now() - t);
      res.push({ status: 0, error: String(e) });
    }
  };
  const t0 = Date.now();
  if (Number(conc) === 1) {
    for (let i = 0; i < total; i++) await one();
  } else {
    await Promise.all(Array.from({ length: total }, one));
  }
  const ids = new Set(res.map((r) => r.instanceId).filter(Boolean));
  const out = {
    proj,
    label,
    startedAt: t0,
    requests: total,
    p50: Math.round(pct(lat, 0.5)),
    p95: Math.round(pct(lat, 0.95)),
    max: Math.round(Math.max(...lat)),
    instances: ids.size,
    cold: res.filter((r) => r.coldStart).length,
    errors,
    maxInflightOnAnInstance: Math.max(
      0,
      ...res.map((r) => r.maxInflightOnInstance || 0),
    ),
    clientPoolSum: (() => {
      const m = {};
      res.forEach((r) => {
        if (r.instanceId)
          m[r.instanceId] = Math.max(m[r.instanceId] || 0, r.poolTotal || 0);
      });
      return Object.values(m).reduce((a, b) => a + b, 0);
    })(),
    fnMsMedian: Math.round(
      pct(
        res.map((r) => r.fnMs || 0),
        0.5,
      ),
    ),
  };
  console.log(JSON.stringify(out));
  require("fs").appendFileSync(
    `../results/A.jsonl`,
    JSON.stringify({ ...out, sample: res.slice(0, 3) }) + "\n",
  );
})();
```

### `lab-vercel2/tools/package.json`

```json
{
  "name": "tools",
  "version": "1.0.0",
  "description": "",
  "main": "index.js",
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "type": "commonjs",
  "dependencies": {
    "pg": "^8.23.1"
  }
}
```

### `lab-vercel2/tools/probe.js`

```js
const { Client } = require("pg");
const fs = require("fs");
const env = fs
  .readFileSync("<path-to-env-file>", "utf8")
  .split("\n")
  .find((l) => l.startsWith("DATABASE_URL="));
const u = new URL(env.slice(13).replace(/^"|"$/g, ""));
u.search = "";
(async () => {
  const c = new Client({
    connectionString: u.toString(),
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  for (let i = 0; i < 6; i++) {
    const r = await c.query(
      "select application_name a,state,count(*)::int n from pg_stat_activity group by 1,2 order by 3 desc limit 8",
    );
    console.log(JSON.stringify(r.rows));
    await new Promise((r) => setTimeout(r, 300));
  }
  await c.end();
})();
```

### `lab-vercel2/tools/q.js`

```js
const fs = require("fs");
const sec = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => /^(QSTASH_|PROBE_|WF_)/.test(k)),
); // credentials come from the environment only
const BASE = sec.QSTASH_URL,
  H = { Authorization: "Bearer " + sec.QSTASH_TOKEN };
const APP = "https://fw-lab-qs.vercel.app";
const out = (o) => {
  const s = JSON.stringify(o);
  console.log(s);
  fs.appendFileSync("../results/C.jsonl", s + "\n");
};
async function publish(path, { body = "", headers = {} } = {}) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/v2/publish/${APP}${path}`, {
    method: "POST",
    headers: { ...H, "Content-Type": "text/plain", ...headers },
    body,
  });
  const j = await r.json();
  return { ...j, status: r.status, t0, t1: Date.now() };
}
const cmd = process.argv[2];
(async () => {
  if (cmd === "latency") {
    for (let i = 0; i < 20; i++) {
      const sentAt = Date.now();
      const r = await publish("/api/receive?tag=lat", {
        body: JSON.stringify({ id: "lat" + i, sentAt }),
      });
      out({
        c: "lat",
        i,
        status: r.status,
        publishCallMs: r.t1 - r.t0,
        sentAt,
        messageId: r.messageId,
      });
      await new Promise((r) => setTimeout(r, 1500));
    }
  } else if (cmd === "long") {
    const s = process.argv[3];
    const r = await publish(`/api/long?s=${s}&k=q${s}`, {
      headers: { "Upstash-Retries": process.argv[4] || "2" },
    });
    out({
      c: "long",
      s,
      status: r.status,
      publishedAt: r.t0,
      messageId: r.messageId,
    });
  } else if (cmd === "delay") {
    const sentAt = Date.now();
    const r = await publish("/api/receive?tag=delay30", {
      body: JSON.stringify({ id: "delay30", sentAt }),
      headers: { "Upstash-Delay": "30s" },
    });
    out({ c: "delay", sentAt, status: r.status, messageId: r.messageId });
  } else if (cmd === "sched") {
    const r = await fetch(`${BASE}/v2/schedules/${APP}/api/receive?tag=sched`, {
      method: "POST",
      headers: {
        ...H,
        "Content-Type": "text/plain",
        "Upstash-Cron": "* * * * *",
      },
      body: JSON.stringify({ id: "sched", sentAt: 0 }),
    });
    const j = await r.json();
    out({ c: "sched_create", at: Date.now(), status: r.status, ...j });
  } else if (cmd === "sched_del") {
    const id = process.argv[3];
    const r = await fetch(`${BASE}/v2/schedules/${id}`, {
      method: "DELETE",
      headers: H,
    });
    out({ c: "sched_delete", at: Date.now(), status: r.status });
    const g = await fetch(`${BASE}/v2/schedules/${id}`, { headers: H });
    out({ c: "sched_get_after_delete", status: g.status });
    const l = await (
      await fetch(`${BASE}/v2/schedules`, { headers: H })
    ).json();
    out({ c: "sched_list", count: l.length, ids: l.map((x) => x.scheduleId) });
  } else if (cmd === "wf") {
    const name = process.argv[3];
    const t0 = Date.now();
    const r = await fetch(`${BASE}/v2/workflows/trigger/${APP}/api/${name}`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
      body: "{}",
    });
    // fallback to Client below if endpoint unsupported
    out({
      c: "wf_trigger_rest",
      name,
      status: r.status,
      t0,
      body: (await r.text()).slice(0, 200),
    });
  } else if (cmd === "wfclient") {
    const { Client } = require("../qs/node_modules/@upstash/workflow");
    const c = new Client({ baseUrl: BASE, token: sec.QSTASH_TOKEN });
    const name = process.argv[3];
    const t0 = Date.now();
    const r = await c.trigger({
      url: `${APP}/api/${name}`,
      body: {},
      retries: 0,
    });
    out({ c: "wf_trigger", name, t0, runId: r.workflowRunId });
  }
})();
```

### `lab-vercel2/tools/sampler.js`

```js
// usage: node sampler.js <appname> <outfile> <ms>
const { Client } = require("<scratch>/lab-vercel2/tools/node_modules/pg");
const fs = require("fs");
const [app, out, ms] = process.argv.slice(2);
const env = fs
  .readFileSync("<path-to-env-file>", "utf8")
  .split("\n")
  .find((l) => l.startsWith("DATABASE_URL="));
const u = new URL(env.slice(13).replace(/^"|"$/g, ""));
u.search = "";
(async () => {
  const c = new Client({
    connectionString: u.toString(),
    ssl: { rejectUnauthorized: false },
    application_name: "fw-lab-sampler",
  });
  await c.connect();
  const end = Date.now() + Number(ms);
  const rows = [];
  while (Date.now() < end) {
    const t = Date.now();
    const r = await c.query(
      "select count(*)::int n from pg_stat_activity where application_name='Supavisor'",
      [],
    );
    rows.push([t, r.rows[0].n]);
    await new Promise((r) => setTimeout(r, 200));
  }
  fs.writeFileSync(out, JSON.stringify(rows));
  await c.end();
})();
```

### `lab-vercel2/wf-d/next.config.ts`

```ts
import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";
const nextConfig: NextConfig = {};
export default withWorkflow(nextConfig);
```

### `lab-vercel2/wf-d/package.json`

```json
{
  "name": "fw-lab-vwf",
  "version": "1.0.0",
  "private": true,
  "scripts": { "build": "next build" },
  "dependencies": {
    "next": "latest",
    "react": "latest",
    "react-dom": "latest",
    "workflow": "5.2.3",
    "pg": "^8.13.0",
    "typescript": "^5",
    "@types/node": "^22",
    "@types/react": "^19",
    "@types/pg": "^8"
  }
}
```

### `lab-vercel2/wf-d/vercel.json`

```json
{
  "regions": ["bom1"],
  "functions": { "app/.well-known/workflow/**": { "maxDuration": 300 } }
}
```

### `lab-vercel2/wf-d/app/layout.tsx`

```tsx
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}
```

### `lab-vercel2/wf-d/app/page.tsx`

```tsx
export default function Page() {
  return <p>fw-lab-vwf: Vercel Workflows lab (bom1)</p>;
}
```

### `lab-vercel2/wf-d/app/api/dual/route.ts`

```ts
import { start } from "workflow/api";
import { threeSteps } from "@/workflows/lab";
import { pool, init, ev } from "@/lib/db";
export const dynamic = "force-dynamic";
// mode=crash_after_insert: row committed, process fails before start()  => row, no run
// mode=rollback_after_start: start() succeeds, then txn rolls back       => run, no row
export async function POST(req: Request) {
  await init();
  const mode = new URL(req.url).searchParams.get("mode") ?? "ok";
  const id = `dual-${mode}-${Date.now()}`;
  const out: Record<string, unknown> = { id, mode };
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("INSERT INTO lab_v2lock.d_orders(id) VALUES ($1)", [id]);
    if (mode === "crash_after_insert") {
      await c.query("COMMIT");
      throw new Error("injected failure before start()");
    }
    const run = await start(threeSteps, [id]);
    out.runId = run.runId;
    if (mode === "rollback_after_start") {
      await c.query("ROLLBACK");
      out.txn = "rolled back after start()";
    } else {
      await c.query("COMMIT");
    }
  } catch (e) {
    out.error = (e as Error).message;
    try {
      await c.query("ROLLBACK");
    } catch {}
  } finally {
    c.release();
  }
  await ev("dual", id, out);
  return Response.json(out);
}
```

### `lab-vercel2/wf-d/app/api/start/route.ts`

```ts
import { start } from "workflow/api";
import { threeSteps, sleep30Step, durableSleep, crashy } from "@/workflows/lab";
import { ev } from "@/lib/db";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const name = new URL(req.url).searchParams.get("w") ?? "three";
  const tag = `${name}-${Date.now()}`;
  const t0 = Date.now();
  const fn = {
    three: threeSteps,
    sleep30: sleep30Step,
    dsleep: durableSleep,
    crash: crashy,
  }[name];
  if (!fn) return Response.json({ error: "unknown" }, { status: 400 });
  const run = await start(fn as typeof threeSteps, [tag]);
  const t1 = Date.now();
  await ev("start", tag, {
    name,
    startCallMs: t1 - t0,
    t0,
    t1,
    runId: run.runId,
  });
  return Response.json({ tag, runId: run.runId, startCallMs: t1 - t0, t0 });
}
```

### `lab-vercel2/wf-d/lib/db.ts`

```ts
import { Pool } from "pg";
const u = new URL(process.env.DATABASE_URL ?? "postgres://none@localhost/none");
u.search = "";
export const pool = new Pool({
  connectionString: u.toString(),
  ssl: { rejectUnauthorized: false },
  max: 3,
  application_name: "fw-lab-vwf",
});
let ready: Promise<unknown> | null = null;
export function init() {
  if (!ready)
    ready = (async () => {
      await pool.query("CREATE SCHEMA IF NOT EXISTS lab_v2lock");
      await pool.query(
        "CREATE TABLE IF NOT EXISTS lab_v2lock.d_events(id bigserial primary key, kind text, key text, at timestamptz not null default clock_timestamp(), t_ms bigint, data jsonb)",
      );
      await pool.query(
        "CREATE TABLE IF NOT EXISTS lab_v2lock.d_orders(id text primary key)",
      );
    })();
  return ready;
}
export async function ev(
  kind: string,
  key: string,
  data: Record<string, unknown> = {},
) {
  await init();
  await pool.query(
    "INSERT INTO lab_v2lock.d_events(kind,key,t_ms,data) VALUES ($1,$2,$3,$4)",
    [kind, key, Date.now(), JSON.stringify(data)],
  );
}
```

### `lab-vercel2/wf-d/workflows/lab.ts`

```ts
import { sleep, getStepMetadata, getWorkflowMetadata } from "workflow";
import { pool, ev } from "@/lib/db";

async function dbStep(label: string, runId: string) {
  "use step";
  const t0 = Date.now();
  const q: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await pool.query("select $1::int", [i]);
    q.push(Math.round((performance.now() - t) * 100) / 100);
  }
  const t1 = Date.now();
  await ev("step", runId, {
    label,
    startMs: t0,
    endMs: t1,
    queryMs: q,
    region: process.env.VERCEL_REGION,
    attempt: getStepMetadata().attempt,
  });
  return { label, startMs: t0, endMs: t1 };
}

export async function threeSteps(runId: string) {
  "use workflow";
  const a = await dbStep("s1", runId);
  const b = await dbStep("s2", runId);
  const c = await dbStep("s3", runId);
  return [a, b, c];
}

async function sleepyStep(runId: string) {
  "use step";
  await ev("sleepy", runId, { phase: "start", t: Date.now() });
  await new Promise((r) => setTimeout(r, 30000));
  await ev("sleepy", runId, { phase: "end", t: Date.now() });
}
export async function sleep30Step(runId: string) {
  "use workflow";
  await sleepyStep(runId);
}

async function mark(runId: string, phase: string) {
  "use step";
  await ev("dsleep", runId, { phase });
}
export async function durableSleep(runId: string) {
  "use workflow";
  await mark(runId, "before");
  await sleep("10s");
  await mark(runId, "after");
}

async function sideEffect(runId: string, n: number) {
  "use step";
  await ev("crash_side_effect", runId, {
    n,
    attempt: getStepMetadata().attempt,
  });
}
async function flaky(runId: string) {
  "use step";
  const attempt = getStepMetadata().attempt;
  await ev("crash_flaky_attempt", runId, { attempt, t: Date.now() });
  if (attempt === 1) throw new Error("injected crash on first attempt");
}
export async function crashy(runId: string) {
  "use workflow";
  await sideEffect(runId, 1);
  await flaky(runId);
  await sideEffect(runId, 3);
}
```

## `lab-cloudflare/`

The `/send`, `/wf/start` and `/dual` routes have no authentication and `/send` takes a caller-supplied count. That was acceptable for a 48-hour throwaway; do not deploy them without auth and a bound, and delete the Workers when the retention ends.

### `lab-cloudflare/package.json`

```json
{
  "name": "fw-lab-cloudflare",
  "private": true,
  "type": "module",
  "dependencies": { "pg": "^8.13.0" }
}
```

### `lab-cloudflare/src/jobs.js`

```js
import pg from "pg";
import { WorkflowEntrypoint } from "cloudflare:workers";
const { Client } = pg;
const now = () => performance.now();
const r = (x) => Math.round(x * 100) / 100;
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function db(env) {
  const u = new URL(env.DATABASE_URL);
  u.search = "";
  const c = new Client({ connectionString: u.toString(), ssl: false });
  await Promise.race([
    c.connect(),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("connect timeout")), 10000),
    ),
  ]);
  return c;
}
async function colo() {
  try {
    const t = await (
      await fetch("https://www.cloudflare.com/cdn-cgi/trace")
    ).text();
    return (t.match(/colo=(\w+)/) || [])[1];
  } catch {
    return null;
  }
}
async function rtt(c, n = 5) {
  const a = [];
  for (let i = 0; i < n; i++) {
    const t = now();
    await c.query("SELECT 1");
    a.push(now() - t);
  }
  return r(median(a));
}
async function ev(c, kind, key, extra = {}) {
  await c.query(
    "INSERT INTO lab_cflock.events(kind,key,data) VALUES ($1,$2,$3)",
    [kind, key, JSON.stringify(extra)],
  );
}
async function setup(c) {
  await c.query("CREATE SCHEMA IF NOT EXISTS lab_cflock");
  await c.query(
    "CREATE TABLE IF NOT EXISTS lab_cflock.events(id bigserial primary key, kind text, key text, at timestamptz default clock_timestamp(), data jsonb)",
  );
}

export class LabWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const env = this.env;
    const id = event.instanceId;
    const stepDb = (name, extra) =>
      step.do(
        name,
        { retries: { limit: 3, delay: "2 seconds" } },
        async (ctx) => {
          const t0 = Date.now();
          const c = await db(env);
          try {
            const tc = Date.now();
            const lat = [];
            for (let i = 0; i < 5; i++) {
              const t = now();
              await c.query('SELECT count(*) FROM "SystemJobExecution"');
              lat.push(now() - t);
            }
            const out = {
              colo: await colo(),
              step: name,
              attempt: ctx.attempt,
              start_ms: t0,
              end_ms: Date.now(),
              connect_ms: tc - t0,
              q_median_ms: r(median(lat)),
              q_all: lat.map(r),
            };
            await ev(c, "wf_step_run", id, {
              step: name,
              attempt: ctx.attempt,
              ...out,
            });
            if (extra && extra.failFirst && ctx.attempt === 1)
              throw new Error("injected failure on attempt 1");
            return out;
          } finally {
            await c.end();
          }
        },
      );
    const s1 = await stepDb("step1");
    const s2 = await stepDb("step2");
    const flaky = await stepDb("flaky", { failFirst: true });
    const s3 = await stepDb("step3");
    const t_sleep0 = Date.now();
    await step.sleep("nap", "10 seconds");
    const slept_ms = Date.now() - t_sleep0;
    const long = await step.do("long30", async (ctx) => {
      const t0 = Date.now();
      await sleep(30000);
      const c = await db(env);
      try {
        await ev(c, "wf_long_run", id, {
          attempt: ctx.attempt,
          start_ms: t0,
          end_ms: Date.now(),
        });
      } finally {
        await c.end();
      }
      return { attempt: ctx.attempt, start_ms: t0, end_ms: Date.now() };
    });
    const sb = await step.do("via_service_binding", async () => {
      const rr = await env.DBW.fetch("https://probe/light");
      const j = await rr.json();
      return {
        colo_ingress: j.colo,
        connect_ms: j.connect_ms,
        total_ms: j.total_ms,
        placement: rr.headers.get("cf-placement"),
      };
    });
    const c = await db(env);
    try {
      await ev(c, "wf_sb", id, sb);
      await ev(c, "wf_done", id, { s1, s2, flaky, s3, slept_ms, long });
    } finally {
      await c.end();
    }
    return { ok: true };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === "/setup") {
        const c = await db(env);
        try {
          await setup(c);
          await c.query(
            "CREATE TABLE IF NOT EXISTS lab_cflock.orders(id text primary key, created timestamptz default now())",
          );
          return Response.json({ ok: true });
        } finally {
          await c.end();
        }
      }
      if (p === "/send") {
        // /send?q=main|fast&type=latency&n=20&gap=1500&secs=0
        const n = +(url.searchParams.get("n") || 1);
        const type = url.searchParams.get("type") || "latency";
        const q = url.searchParams.get("q") === "fast" ? env.Q_FAST : env.Q;
        const tag =
          url.searchParams.get("tag") || crypto.randomUUID().slice(0, 8);
        const secs = +(url.searchParams.get("secs") || 0);
        const batch = url.searchParams.get("batch") === "1";
        const msgs = [];
        for (let i = 0; i < n; i++)
          msgs.push({
            body: {
              type,
              tag,
              i,
              secs,
              it: +(url.searchParams.get("it") || 0),
              sent_ms: 0,
            },
          });
        if (batch) {
          const t = Date.now();
          msgs.forEach((m) => (m.body.sent_ms = t));
          await q.sendBatch(msgs);
        } else {
          for (const m of msgs) {
            m.body.sent_ms = Date.now();
            await q.send(m.body);
            if (n > 1) await sleep(+(url.searchParams.get("gap") || 1000));
          }
        }
        return Response.json({ sent: n, tag });
      }
      if (p === "/dual") {
        // insert row, fail before send
        const id = "ord-" + crypto.randomUUID().slice(0, 8);
        const c = await db(env);
        try {
          await c.query("INSERT INTO lab_cflock.orders(id) VALUES ($1)", [id]);
          if (url.searchParams.get("fail") === "1")
            throw new Error("injected failure before queue.send");
          await env.Q.send({
            type: "latency",
            tag: "dual",
            i: 0,
            order: id,
            sent_ms: Date.now(),
          });
          return Response.json({ id, sent: true });
        } catch (e) {
          const row = await c.query(
            "SELECT id FROM lab_cflock.orders WHERE id=$1",
            [id],
          );
          return Response.json({
            id,
            error: e.message,
            row_exists: row.rowCount === 1,
            message_enqueued: false,
          });
        } finally {
          await c.end();
        }
      }
      if (p === "/wf/start") {
        const inst = await env.WF.create({
          params: { tag: url.searchParams.get("tag") || "t" },
        });
        return Response.json({ id: inst.id });
      }
      if (p === "/wf/status") {
        const inst = await env.WF.get(url.searchParams.get("id"));
        return Response.json(await inst.status());
      }
      if (p === "/wf/dual") {
        // BEGIN; insert; create workflow; ROLLBACK
        const c = await db(env);
        try {
          await c.query("BEGIN");
          const oid = "wford-" + crypto.randomUUID().slice(0, 8);
          await c.query("INSERT INTO lab_cflock.orders(id) VALUES ($1)", [oid]);
          const inst = await env.WF.create({ params: { tag: "dual" } });
          await c.query("ROLLBACK");
          const row = await c.query(
            "SELECT id FROM lab_cflock.orders WHERE id=$1",
            [oid],
          );
          const st = await inst.status();
          return Response.json({
            oid,
            wf: inst.id,
            row_exists_after_rollback: row.rowCount === 1,
            workflow_status: st.status,
          });
        } finally {
          await c.end();
        }
      }
      if (p === "/viasb") {
        const rr = await env.DBW.fetch("https://probe/light");
        return Response.json({
          placement: rr.headers.get("cf-placement"),
          body: await rr.json(),
        });
      }
      if (p === "/cpu") {
        const it = +(url.searchParams.get("it") || 1e6);
        let x = 0;
        for (let i = 0; i < it; i++) x += Math.sqrt(i);
        return Response.json({ it, x: x > 0 });
      }
      if (p === "/events") {
        const c = await db(env);
        try {
          const res = await c.query(
            `SELECT id,kind,key,(extract(epoch from at)*1000)::bigint AS at_ms,data FROM lab_cflock.events WHERE ($1::text IS NULL OR kind=$1) AND ($2::text IS NULL OR key=$2) ORDER BY id`,
            [url.searchParams.get("kind"), url.searchParams.get("key")],
          );
          return Response.json(res.rows);
        } finally {
          await c.end();
        }
      }
      return Response.json({
        routes: [
          "/setup",
          "/send",
          "/dual",
          "/wf/start",
          "/wf/status",
          "/wf/dual",
          "/events",
        ],
      });
    } catch (e) {
      return Response.json({ error: String(e.message) }, { status: 500 });
    }
  },

  async queue(batch, env) {
    const t_start = Date.now();
    const c = await db(env);
    try {
      const rt = await rtt(c, 3);
      const cl = await colo();
      for (let idx = 0; idx < batch.messages.length; idx++) {
        const m = batch.messages[idx];
        const b = m.body;
        if (batch.queue.endsWith("dlq")) {
          await ev(c, "dlq", b.tag, {
            i: b.i,
            attempts: m.attempts,
            orig: b.type,
            at_ms: Date.now(),
          });
          m.ack();
          continue;
        }
        const base = {
          colo: cl,
          i: b.i,
          attempts: m.attempts,
          batch_size: batch.messages.length,
          batch_idx: idx,
          sent_ms: b.sent_ms,
          consumed_ms: Date.now(),
          invoke_start_ms: t_start,
          rtt_ms: rt,
          queue: batch.queue,
        };
        if (b.type === "latency") {
          await ev(c, "q_latency", b.tag, base);
          m.ack();
        } else if (b.type === "retry_once") {
          await ev(c, "q_retry", b.tag, base);
          if (m.attempts === 1)
            throw new Error("injected first attempt failure");
          await ev(c, "q_retry_ok", b.tag, base);
          m.ack();
        } else if (b.type === "always_fail") {
          await ev(c, "q_alwaysfail", b.tag, base);
          throw new Error("always fail");
        } else if (b.type === "long") {
          await ev(c, "q_long_start", b.tag, base);
          await sleep(b.secs * 1000);
          const c2 = await db(env);
          try {
            await ev(c2, "q_long_end", b.tag, { ...base, end_ms: Date.now() });
          } finally {
            await c2.end();
          }
          m.ack();
        } else if (b.type === "sb") {
          const rr = await env.DBW.fetch("https://probe/light");
          const j = await rr.json();
          await ev(c, "q_sb", b.tag, {
            ...base,
            sb: j,
            placement: rr.headers.get("cf-placement"),
          });
          m.ack();
        } else if (b.type === "cpu") {
          await ev(c, "q_cpu_start", b.tag, base);
          let x = 0;
          for (let i = 0; i < b.it; i++) x += Math.sqrt(i);
          const c2 = await db(env);
          try {
            await ev(c2, "q_cpu_end", b.tag, { ...base, end_ms: Date.now() });
          } finally {
            await c2.end();
          }
          m.ack();
        }
      }
    } finally {
      try {
        await c.end();
      } catch {}
    }
  },

  async scheduled(controller, env) {
    const c = await db(env);
    try {
      const rt = await rtt(c, 3);
      await ev(c, "cron", controller.cron, {
        colo: await colo(),
        scheduled_ms: controller.scheduledTime,
        fired_ms: Date.now(),
        rtt_ms: rt,
      });
    } finally {
      await c.end();
    }
  },
};
```

### `lab-cloudflare/src/probe.js`

```js
import pg from "pg";
const { Client } = pg;
const now = () => performance.now();
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};
const r = (x) => Math.round(x * 100) / 100;
let coldFlag = true;
const born = Date.now();

export default {
  async fetch(request, env) {
    const cold = coldFlag;
    coldFlag = false;
    const url = new URL(request.url);
    const out = {
      worker: env.VARIANT,
      colo: request.cf && request.cf.colo,
      country: request.cf && request.cf.country,
      placement_hdr: request.headers.get("cf-placement"),
      ray: null,
      cold,
    };
    if (url.pathname === "/ping") return Response.json(out);
    const t0 = now();
    let cfg, c;
    const ID = parseInt((env.VARIANT || "v0").slice(1), 10);
    const light = url.pathname === "/light";
    try {
      if (env.HYPERDRIVE)
        cfg = { connectionString: env.HYPERDRIVE.connectionString };
      else {
        const u = new URL(env.DATABASE_URL);
        u.search = "";
        cfg = { connectionString: u.toString(), ssl: false };
      }
      c = new Client(cfg);
      let t = now();
      await Promise.race([
        c.connect(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("connect timeout 10s")), 10000),
        ),
      ]);
      out.connect_ms = r(now() - t);
      if (light) {
        for (let i = 0; i < 5; i++) await c.query("SELECT 1");
        out.total_ms = r(now() - t0);
        return Response.json(out);
      }
      const s1 = [];
      for (let i = 0; i < 50; i++) {
        t = now();
        await c.query("SELECT 1");
        s1.push(now() - t);
      }
      out.select1 = {
        median_ms: r(pct(s1, 0.5)),
        p95_ms: r(pct(s1, 0.95)),
        min_ms: r(Math.min(...s1)),
      };
      const qs = [
        'SELECT id, "paymentStatus" FROM "Payment" ORDER BY "createdAt" DESC LIMIT 50',
        'SELECT id, "createdAt" FROM "Appointment" ORDER BY "createdAt" DESC LIMIT 50',
        'SELECT id, status FROM "SystemJobExecution" ORDER BY "createdAt" DESC LIMIT 50',
        `SELECT count(*) FROM "Payment" WHERE "paymentStatus"::text = 'SUCCEEDED'`,
        `SELECT count(*) FROM "SystemJobExecution" WHERE status::text = 'SUCCEEDED'`,
      ];
      t = now();
      for (let i = 0; i < 20; i++) await c.query(qs[i % qs.length]);
      out.mix20_total_ms = r(now() - t);
      await c.query("CREATE SCHEMA IF NOT EXISTS lab_cflock");
      await c.query(
        "CREATE TABLE IF NOT EXISTS lab_cflock.account(id int primary key, balance bigint, version int)",
      );
      await c.query(
        `INSERT INTO lab_cflock.account VALUES (${ID},1000,0) ON CONFLICT DO NOTHING`,
      );
      const holds = [];
      for (let i = 0; i < 10; i++) {
        await c.query("BEGIN");
        const row = (
          await c.query(
            `SELECT balance, version FROM lab_cflock.account WHERE id=${ID} FOR UPDATE`,
          )
        ).rows[0];
        t = now();
        await c.query("SELECT 1");
        await c.query("SELECT count(*) FROM lab_cflock.account");
        await c.query(`SELECT balance FROM lab_cflock.account WHERE id=${ID}`);
        const u = await c.query(
          `UPDATE lab_cflock.account SET balance=balance+1, version=version+1 WHERE id=${ID} AND version=$1`,
          [row.version],
        );
        if (u.rowCount !== 1) throw new Error("CAS failed");
        await c.query(`SELECT version FROM lab_cflock.account WHERE id=${ID}`);
        await c.query("SELECT 1");
        await c.query("SELECT now()");
        await c.query(`SELECT balance FROM lab_cflock.account WHERE id=${ID}`);
        await c.query("COMMIT");
        holds.push(now() - t);
      }
      out.lock_hold = {
        median_ms: r(pct(holds, 0.5)),
        p95_ms: r(pct(holds, 0.95)),
      };
    } catch (e) {
      out.error = String(e && e.message).slice(0, 300);
      try {
        await c.query("ROLLBACK");
      } catch {}
    } finally {
      try {
        await c.end();
      } catch {}
    }
    out.total_ms = r(now() - t0);
    return Response.json(out);
  },
};
```

### `lab-cloudflare/cfg/jobs.toml`

```toml
name = "fw-lab-jobs"
main = "../src/jobs.js"
compatibility_date = "2026-10-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true
[observability]
enabled = true
[triggers]
crons = []
[[queues.producers]]
binding = "Q"
queue = "fw-lab-q"
[[queues.producers]]
binding = "Q_FAST"
queue = "fw-lab-q-fast"
[[queues.consumers]]
queue = "fw-lab-q"
max_batch_size = 10
max_batch_timeout = 5
max_retries = 2
dead_letter_queue = "fw-lab-dlq"
[[queues.consumers]]
queue = "fw-lab-q-fast"
max_batch_size = 1
max_batch_timeout = 0
max_retries = 2
dead_letter_queue = "fw-lab-dlq"
[[queues.consumers]]
queue = "fw-lab-dlq"
[[workflows]]
name = "fw-lab-wf"
binding = "WF"
class_name = "LabWorkflow"

[[services]]
binding = "DBW"
service = "fw-lab-v5-region"
```

### `lab-cloudflare/cfg/plantest.toml`

```toml
name = "fw-lab-plantest"
main = "../src/probe.js"
compatibility_date = "2026-10-01"
workers_dev = false
[limits]
cpu_ms = 60000
```

### `lab-cloudflare/cfg/v1-direct.toml`

```toml
name = "fw-lab-v1-direct"
main = "../src/probe.js"
compatibility_date = "2026-10-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true
[observability]
enabled = true
[vars]
VARIANT = "v1-direct"
```

### `lab-cloudflare/cfg/v2-hd.toml`

```toml
name = "fw-lab-v2-hd"
main = "../src/probe.js"
compatibility_date = "2026-10-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true
[observability]
enabled = true
[vars]
VARIANT = "v2-hd"
```

### `lab-cloudflare/cfg/v3-smart.toml`

```toml
name = "fw-lab-v3-smart"
main = "../src/probe.js"
compatibility_date = "2026-10-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true
[observability]
enabled = true
[vars]
VARIANT = "v3-smart"
[placement]
mode = "smart"
```

### `lab-cloudflare/cfg/v4-smart-hd.toml`

```toml
name = "fw-lab-v4-smart-hd"
main = "../src/probe.js"
compatibility_date = "2026-10-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true
[observability]
enabled = true
[vars]
VARIANT = "v4-smart-hd"
[placement]
mode = "smart"
```

### `lab-cloudflare/cfg/v5-region.toml`

```toml
name = "fw-lab-v5-region"
main = "../src/probe.js"
compatibility_date = "2026-10-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true
[observability]
enabled = true
[vars]
VARIANT = "v5-region"
[placement]
region = "aws:ap-south-1"
```

### `lab-cloudflare/cfg/v6-region-hd.toml`

```toml
name = "fw-lab-v6-region-hd"
main = "../src/probe.js"
compatibility_date = "2026-10-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true
[observability]
enabled = true
[vars]
VARIANT = "v6-region-hd"
[placement]
region = "aws:ap-south-1"
```

### `lab-cloudflare/cfg/v7-host.toml`

```toml
name = "fw-lab-v7-host"
main = "../src/probe.js"
compatibility_date = "2026-10-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true
[observability]
enabled = true
[vars]
VARIANT = "v7-host"
[placement]
host = "<supabase-pooler-host>:6543"
```

## `lab-netlify-bg/`

The four earlier functions (`db-probe`, `inngest`, `qs`, `wf`) were redeployed unchanged from `lab-netlify/` and are not repeated.

### `lab-netlify-bg/package.json`

```json
{
  "name": "lab-netlify",
  "version": "1.0.0",
  "description": "",
  "main": "index.js",
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "type": "commonjs",
  "dependencies": {
    "@upstash/qstash": "^2.12.1",
    "@upstash/workflow": "^1.5.0",
    "inngest": "^4.26.2",
    "pg": "^8.23.1",
    "zod": "^4.6.7"
  }
}
```

### `lab-netlify-bg/netlify.toml`

```toml
[build]
  publish = "public"
[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"
  external_node_modules = ["pg"]
```

### `lab-netlify-bg/setup.mjs`

```js
import pg from "pg";
const c = new pg.Client({
  connectionString: process.env.PROBE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();
const cmd = process.argv[2];
if (cmd === "up") {
  await c.query("CREATE SCHEMA IF NOT EXISTS lab_nbg");
  await c.query(
    "CREATE TABLE IF NOT EXISTS lab_nbg.events(id bigserial primary key, run text, kind text, note jsonb, aws_req text, region text, ts timestamptz default clock_timestamp())",
  );
  await c.query(
    "CREATE TABLE IF NOT EXISTS lab_nbg.account(id int primary key, balance bigint, version int)",
  );
} else if (cmd === "down") {
  await c.query("DROP SCHEMA IF EXISTS lab_nbg CASCADE");
  const r = await c.query(
    "select nspname from pg_namespace where nspname like 'lab_nbg%'",
  );
  console.log("remaining lab_nbg schemas:", r.rowCount);
} else if (cmd === "q") {
  const r = await c.query(process.argv[3]);
  console.table(r.rows);
}
await c.end();
```

### `lab-netlify-bg/trig.mjs`

```js
import { Client } from "@upstash/workflow";
const c = new Client({
  baseUrl: "http://127.0.0.1:8080",
  token: "<qstash-dev-server-default-token>",
});
const name = process.argv[2];
console.log(new Date().toISOString(), "trigger", name);
const r = await c.trigger({
  url: `https://fw-probe-jobs-27089.netlify.app/api/wf/${name}`,
  body: {},
  retries: 0,
});
console.log(r);
```

### `lab-netlify-bg/netlify/lib/lab.cjs`

```js
const pg = require("pg");
const client = () =>
  new pg.Client({
    connectionString: process.env.PROBE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
async function ev(run, kind, note = {}) {
  const c = client();
  await c.connect();
  try {
    await c.query(
      "INSERT INTO lab_nbg.events(run, kind, note, region) VALUES ($1,$2,$3,$4)",
      [run, kind, JSON.stringify(note), process.env.AWS_REGION],
    );
  } finally {
    await c.end();
  }
}
module.exports = { client, ev };
```

### `lab-netlify-bg/netlify/lib/lab.mjs`

```js
import pg from "pg";
export const client = () =>
  new pg.Client({
    connectionString: process.env.PROBE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
export async function ev(run, kind, note = {}) {
  const c = client();
  await c.connect();
  try {
    const r = await c.query(
      "INSERT INTO lab_nbg.events(run, kind, note, aws_req, region) VALUES ($1,$2,$3,$4,$5) RETURNING id, ts",
      [
        run,
        kind,
        JSON.stringify(note),
        process.env._X_AMZN_TRACE_ID ?? null,
        process.env.AWS_REGION,
      ],
    );
    return r.rows[0];
  } finally {
    await c.end();
  }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
```

### `lab-netlify-bg/netlify/functions/flaky-background.mjs`

```js
import { ev, client } from "../lib/lab.mjs";
export default async (req) => {
  const u = new URL(req.url);
  const run = u.searchParams.get("run");
  const mode = u.searchParams.get("mode") ?? "once";
  const c = client();
  await c.connect();
  const { rows } = await c.query(
    "SELECT count(*)::int n FROM lab_nbg.events WHERE run=$1 AND kind='attempt'",
    [run],
  );
  await c.end();
  const attempt = rows[0].n + 1;
  await ev(run, "attempt", { attempt, mode });
  await ev(run, "side_effect", { attempt });
  if (mode === "always" || attempt === 1) {
    await ev(run, "throw", { attempt });
    throw new Error(`boom attempt ${attempt}`);
  }
  await ev(run, "end", { attempt });
};
```

### `lab-netlify-bg/netlify/functions/flakyexit-background.mjs`

```js
import { ev, client } from "../lib/lab.mjs";
export default async (req) => {
  const u = new URL(req.url);
  const run = u.searchParams.get("run");
  const mode = u.searchParams.get("mode") ?? "once";
  const c = client();
  await c.connect();
  const { rows } = await c.query(
    "SELECT count(*)::int n FROM lab_nbg.events WHERE run=$1 AND kind='attempt'",
    [run],
  );
  await c.end();
  const attempt = rows[0].n + 1;
  await ev(run, "attempt", { attempt, mode });
  await ev(run, "side_effect", { attempt });
  if (mode === "always" || attempt === 1) {
    await ev(run, "throw", { attempt });
    process.exit(1);
  }
  await ev(run, "end", { attempt });
};
```

### `lab-netlify-bg/netlify/functions/flakyv1-background.js`

```js
const { ev, client } = require("../lib/lab.cjs");
exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const run = q.run,
    mode = q.mode || "once";
  const c = client();
  await c.connect();
  const { rows } = await c.query(
    "SELECT count(*)::int n FROM lab_nbg.events WHERE run=$1 AND kind='attempt'",
    [run],
  );
  await c.end();
  const attempt = rows[0].n + 1;
  await ev(run, "attempt", { attempt, mode });
  await ev(run, "side_effect", { attempt });
  if (mode === "always" || attempt === 1) {
    await ev(run, "throw", { attempt });
    throw new Error("boom v1 " + attempt);
  }
  await ev(run, "end", { attempt });
  return { statusCode: 200 };
};
```

### `lab-netlify-bg/netlify/functions/job-background.mjs`

```js
import { ev, sleep } from "../lib/lab.mjs";
export default async (req) => {
  const u = new URL(req.url);
  const s = Number(u.searchParams.get("s") ?? 10);
  const run = u.searchParams.get("run") ?? `s${s}-${Date.now()}`;
  await ev(run, "start", { s });
  const t0 = Date.now();
  const hb = Number(u.searchParams.get("hb") ?? 30);
  let next = hb;
  while ((Date.now() - t0) / 1000 < s) {
    await sleep(Math.min(1000, s * 1000 - (Date.now() - t0)));
    const el = (Date.now() - t0) / 1000;
    if (el >= next && el < s) {
      await ev(run, "hb", { el: Math.round(el) });
      next += hb;
    }
  }
  await ev(run, "end", { s, elapsedMs: Date.now() - t0 });
};
```

### `lab-netlify-bg/netlify/functions/probe-background.mjs`

```js
import pg from "pg";
import { ev } from "../lib/lab.mjs";
const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const p95 = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
};
const now = () => performance.now();
const r1 = (x) => Math.round(x * 10) / 10;
export default async (req) => {
  const run = new URL(req.url).searchParams.get("run") ?? `probe-${Date.now()}`;
  await ev(run, "start");
  const out = { awsRegion: process.env.AWS_REGION, node: process.version };
  const c = new pg.Client({
    connectionString: process.env.PROBE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  const t0 = now();
  try {
    let t = now();
    await c.connect();
    out.connectMs = r1(now() - t);
    const s1 = [];
    for (let i = 0; i < 50; i++) {
      t = now();
      await c.query("SELECT 1");
      s1.push(now() - t);
    }
    out.select1 = {
      medianMs: r1(med(s1)),
      p95Ms: r1(p95(s1)),
      minMs: r1(Math.min(...s1)),
      maxMs: r1(Math.max(...s1)),
    };
    const mix = [
      'SELECT id, "paymentStatus" FROM "Payment" ORDER BY "createdAt" DESC LIMIT 50',
      'SELECT id, "createdAt" FROM "Appointment" ORDER BY "createdAt" DESC LIMIT 50',
      'SELECT id, "jobName", status FROM "SystemJobExecution" ORDER BY "createdAt" DESC LIMIT 50',
      'SELECT count(*) FROM "Payment" WHERE "paymentStatus"::text = \'SUCCEEDED\'',
      'SELECT count(*) FROM "Appointment" WHERE "createdAt" > now() - interval \'90 days\'',
    ];
    t = now();
    for (let i = 0; i < 20; i++) await c.query(mix[i % 5]);
    out.mix20TotalMs = r1(now() - t);
    await c.query(
      "CREATE TABLE IF NOT EXISTS lab_nbg.account(id int primary key, balance bigint, version int)",
    );
    await c.query(
      "INSERT INTO lab_nbg.account VALUES (1,1000,0),(2,1000,0) ON CONFLICT DO NOTHING",
    );
    const holds = [];
    for (let i = 0; i < 10; i++) {
      t = now();
      await c.query("BEGIN");
      const r = await c.query(
        "SELECT id, balance, version FROM lab_nbg.account WHERE id=1 FOR UPDATE",
      );
      const v = r.rows[0].version;
      await c.query("SELECT balance FROM lab_nbg.account WHERE id=2");
      await c.query("SELECT count(*) FROM lab_nbg.account");
      await c.query(
        "UPDATE lab_nbg.account SET balance=balance+1, version=version+1 WHERE id=1 AND version=$1",
        [v],
      );
      await c.query("UPDATE lab_nbg.account SET balance=balance-1 WHERE id=2");
      await c.query("SELECT balance FROM lab_nbg.account WHERE id=1");
      await c.query("SELECT balance FROM lab_nbg.account WHERE id=2");
      await c.query("SELECT 1");
      await c.query("SELECT now()");
      await c.query("COMMIT");
      holds.push(now() - t);
    }
    out.lockHold = { medianMs: r1(med(holds)), p95Ms: r1(p95(holds)) };
  } catch (e) {
    out.error = String(e.message).replace(/postgresql:\/\/\S+/g, "<url>");
  } finally {
    try {
      await c.end();
    } catch {}
  }
  out.totalMs = r1(now() - t0);
  await ev(run, "end", out);
};
```

The `lab-drain-tls/` and `lab-netlify-aw/` sections below were appended last. The pg-boss drain scripts connect with `ssl: { rejectUnauthorized: false }` against a mock database: do not copy that setting. The Supabase root CA certificate and the Hyperdrive config ids are replaced with placeholders.

## `lab-drain-tls/`

### `lab-drain-tls/abandon.mjs`

```js
import { makeBoss, drain, QUEUE } from "./lib/drain.mjs";
import { SESS } from "./lib/env.mjs";
import { spawnSync } from "node:child_process";
const seeder = makeBoss(SESS);
seeder.on("error", () => {});
await seeder.start();
await seeder.deleteAllJobs(QUEUE);
await seeder.insert(
  QUEUE,
  Array.from({ length: 5 }, (_, i) => ({ data: { i } })),
);
await seeder.stop({ graceful: false });
// process 1: fetch 5 then die (exit without complete)
const r = spawnSync(
  "node",
  [
    "-e",
    `
import("./lib/drain.mjs").then(async ({makeBoss,QUEUE})=>{const {SESS}=await import("./lib/env.mjs");
const b=makeBoss(SESS);b.on("error",()=>{});await b.start();const j=await b.fetch(QUEUE,{batchSize:10});console.log("fetched",j.length);process.exit(0)})`,
  ],
  { encoding: "utf8" },
);
const tDie = Date.now();
console.log(r.stdout.trim());
// probe loop: drain with supervise:false (pure fetch) every 3s, up to 40s
const b = makeBoss(SESS);
b.on("error", () => {});
await b.start();
let redeliveredNoSup = null;
for (let s = 0; s <= 36; s += 3) {
  const j = await b.fetch(QUEUE, { batchSize: 10 });
  console.log(
    `t+${((Date.now() - tDie) / 1000).toFixed(1)}s fetch(no supervise) -> ${j.length}`,
  );
  if (j.length) {
    redeliveredNoSup = Date.now() - tDie;
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
const q = await b.getQueueStats?.(QUEUE).catch?.(() => null);
console.log("no-supervise redelivered:", redeliveredNoSup);
let t = performance.now();
await b.supervise(QUEUE);
console.log("supervise(queue) ms", (performance.now() - t).toFixed(0));
const j2 = await b.fetch(QUEUE, { batchSize: 10, includeMetadata: true });
console.log(
  `t+${((Date.now() - tDie) / 1000).toFixed(1)}s after supervise fetch ->`,
  j2.length,
  "retryCount",
  j2[0]?.retryCount,
);
await b.complete(
  QUEUE,
  j2.map((x) => x.id),
);
await b.stop({ graceful: false });
```

### `lab-drain-tls/abandon2.mjs`

```js
import { makeBoss, QUEUE } from "./lib/drain.mjs";
import { SESS } from "./lib/env.mjs";
import { spawnSync } from "node:child_process";
const mon = +process.argv[2];
const s = makeBoss(SESS, { monitorIntervalSeconds: mon });
s.on("error", () => {});
await s.start();
await s.deleteAllJobs(QUEUE);
await s.supervise(QUEUE); // stamps the monitor claim "now"
await s.insert(
  QUEUE,
  Array.from({ length: 5 }, (_, i) => ({ data: { i } })),
);
await s.stop({ graceful: false });
spawnSync("node", [
  "-e",
  `import("./lib/drain.mjs").then(async({makeBoss,QUEUE})=>{const {SESS}=await import("./lib/env.mjs");const b=makeBoss(SESS);b.on("error",()=>{});await b.start();await b.fetch(QUEUE,{batchSize:10});process.exit(0)})`,
]);
const t0 = Date.now();
let tick = 0;
while (Date.now() - t0 < 100000) {
  tick++;
  const b = makeBoss(SESS, { monitorIntervalSeconds: mon });
  b.on("error", () => {});
  await b.start();
  const ts = performance.now();
  await b.supervise(QUEUE);
  const supMs = performance.now() - ts;
  const j = await b.fetch(QUEUE, { batchSize: 10, includeMetadata: true });
  console.log(
    `mon=${mon} tick ${tick} t+${((Date.now() - t0) / 1000).toFixed(1)}s supervise ${supMs.toFixed(0)}ms fetched ${j.length} retryCount ${j[0]?.retryCount ?? "-"}`,
  );
  if (j.length) {
    await b.complete(
      QUEUE,
      j.map((x) => x.id),
    );
    await b.stop({ graceful: false });
    break;
  }
  await b.stop({ graceful: false });
  await new Promise((r) => setTimeout(r, 5000));
}
```

### `lab-drain-tls/bench.mjs`

```js
import { makeBoss, drain, QUEUE } from "./lib/drain.mjs";
import { SESS, TXN } from "./lib/env.mjs";
const which = process.argv[2],
  n = +process.argv[3] || 200,
  batch = +process.argv[4] || 10;
const url = which === "txn" ? TXN : SESS;
const seeder = makeBoss(url);
seeder.on("error", () => {});
await seeder.start();
let t = performance.now();
await seeder.insert(
  QUEUE,
  Array.from({ length: n }, (_, i) => ({ data: { i } })),
);
const seedMs = performance.now() - t;
await seeder.stop({ graceful: false });
const m = await drain(url, { batchSize: batch, work: async () => {} });
const sum = (a) => a.reduce((x, y) => x + y, 0);
console.log(
  JSON.stringify({
    which,
    n,
    batch,
    seedMs: +seedMs.toFixed(0),
    startMs: +m.startMs.toFixed(0),
    jobs: m.jobs,
    batches: m.batches,
    fetchAvgMs: +(sum(m.fetchMs) / m.fetchMs.length).toFixed(1),
    completeAvgMs: +(
      sum(m.completeMs) / Math.max(1, m.completeMs.length)
    ).toFixed(1),
    stopMs: +m.stopMs.toFixed(0),
    totalMs: +m.totalMs.toFixed(0),
    perJobMs: +(
      (m.totalMs - m.startMs - m.stopMs) /
      Math.max(1, m.jobs)
    ).toFixed(1),
  }),
);
```

### `lab-drain-tls/conc1.mjs`

```js
import { drain } from "./lib/drain.mjs";
import { SESS } from "./lib/env.mjs";
import fs from "node:fs";
const m = await drain(SESS, {
  batchSize: 10,
  work: async () => new Promise((r) => setTimeout(r, 5)),
});
fs.writeFileSync(process.argv[2], JSON.stringify(m.ids));
console.log(process.argv[2], "jobs", m.jobs, "total ms", m.totalMs.toFixed(0));
```

### `lab-drain-tls/package.json`

```json
{
  "name": "lab-drain-tls",
  "version": "1.0.0",
  "description": "",
  "main": "index.js",
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "type": "commonjs",
  "dependencies": {
    "pg": "^8.23.1",
    "pg-boss": "^12.38.0",
    "postgres": "^4.0.0"
  }
}
```

### `lab-drain-tls/q.mjs`

```js
import pg from "pg";
import { SESS } from "./lib/env.mjs";
const c = new pg.Client({
  connectionString: SESS,
  ssl: { rejectUnauthorized: false },
});
await c.connect();
const r = await c.query(process.argv[2]);
console.log(JSON.stringify(r.rows));
await c.end();
```

### `lab-drain-tls/seed.mjs`

```js
import { makeBoss, QUEUE } from "./lib/drain.mjs";
import { SESS } from "./lib/env.mjs";
const n = +process.argv[2];
const b = makeBoss(SESS);
b.on("error", () => {});
await b.start();
await b.deleteAllJobs(QUEUE);
await b.insert(
  QUEUE,
  Array.from({ length: n }, (_, i) => ({ data: { i } })),
);
await b.stop({ graceful: false });
console.log("seeded", n);
```

### `lab-drain-tls/setup.mjs`

```js
import { makeBoss, QUEUE } from "./lib/drain.mjs";
import { SESS, TXN } from "./lib/env.mjs";
const which = process.argv[2] || "sess";
const url = which === "txn" ? TXN : SESS;
const t = performance.now();
const boss = makeBoss(url);
boss.on("error", (e) => console.log("err", e.message));
await boss.start();
console.log(
  "cold start() ms",
  (performance.now() - t).toFixed(0),
  "via",
  which,
);
await boss.createQueue(QUEUE, {
  expireInSeconds: 15,
  retryLimit: 3,
  retryDelay: 0,
});
console.log("schemaVersion", await boss.schemaVersion());
await boss.stop({ graceful: false });
```

### `lab-drain-tls/sup.mjs`

```js
import { makeBoss, QUEUE } from "./lib/drain.mjs";
import { SESS } from "./lib/env.mjs";
const b = makeBoss(SESS, { monitorIntervalSeconds: +process.argv[2] || 60 });
b.on("error", () => {});
await b.start();
let t = performance.now();
await b.supervise(QUEUE);
console.log("supervise ms", (performance.now() - t).toFixed(0));
const j = await b.fetch(QUEUE, { batchSize: 10, includeMetadata: true });
console.log(
  "fetched",
  j.length,
  "retryCount",
  j[0]?.retryCount,
  "state",
  j[0]?.state,
);
if (j.length)
  await b.complete(
    QUEUE,
    j.map((x) => x.id),
  );
await b.stop({ graceful: false });
```

### `lab-drain-tls/txsend.mjs`

```js
import pg from "pg";
import { makeBoss, drain, QUEUE } from "./lib/drain.mjs";
import { SESS, TXN } from "./lib/env.mjs";
for (const [label, url] of [
  ["session:5432", SESS],
  ["txn:6543", TXN],
]) {
  const boss = makeBoss(url);
  boss.on("error", () => {});
  await boss.start();
  await boss.deleteAllJobs(QUEUE);
  const c = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  await c.query(
    "create table if not exists lab_pgdrain.biz(id serial primary key, v text)",
  );
  const db = { executeSql: (text, values) => c.query(text, values) };
  // commit case
  await c.query("begin");
  await c.query("insert into lab_pgdrain.biz(v) values('commit')");
  const idC = await boss.send(QUEUE, { v: "commit" }, { db });
  const visibleOutside = (await boss
    .getQueueStats?.(QUEUE, { force: true })
    .catch(() => null))
    ? "n/a"
    : "n/a";
  await c.query("commit");
  // rollback case
  await c.query("begin");
  await c.query("insert into lab_pgdrain.biz(v) values('rollback')");
  const idR = await boss.send(QUEUE, { v: "rollback" }, { db });
  await c.query("rollback");
  await c.end();
  await boss.stop({ graceful: false });
  const m = await drain(url, { batchSize: 10 });
  console.log(
    label,
    JSON.stringify({ idCommit: !!idC, idRollback: !!idR, drainedJobs: m.jobs }),
  );
}
```

### `lab-drain-tls/cf/package.json`

```json
{
  "name": "cf",
  "version": "1.0.0",
  "description": "",
  "main": "index.js",
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "type": "commonjs",
  "dependencies": {
    "pg": "^8.23.1",
    "pg-cloudflare": "^1.4.1",
    "postgres": "^4.0.0"
  }
}
```

### `lab-drain-tls/cf/wrangler.jsonc`

```jsonc
{
  "name": "fw-lab-tls",
  "main": "src/index.js",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "placement": { "region": "aws:ap-south-1" },
  "workers_dev": true,
  "hyperdrive": [
    { "binding": "HD", "id": "<hyperdrive-config-id>" },
    { "binding": "HD_POOLER", "id": "<hyperdrive-pooler-config-id>" },
  ],
}
```

### `lab-drain-tls/cf/src/index.js`

```js
import { Client } from "pg";
import postgres from "postgres";
const CA = `<supabase-root-2021-ca-pem: download prod-ca-2021.crt from the Supabase SSL page>`;
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const p95 = (a) => [...a].sort((x, y) => x - y)[Math.ceil(a.length * 0.95) - 1];
const r1 = (n) => +n.toFixed(1);

async function measure(q /* async (sql, params?) => rows */, out) {
  const lat = [];
  for (let i = 0; i < 50; i++) {
    const s = performance.now();
    await q("select 1");
    lat.push(performance.now() - s);
  }
  out.select1 = { n: 50, medianMs: r1(med(lat)), p95Ms: r1(p95(lat)) };
  const s = performance.now();
  await q("begin");
  await q("create schema if not exists lab_cftls");
  await q("create table if not exists lab_cftls.t(id int primary key, v int)");
  await q("insert into lab_cftls.t values (1,0) on conflict (id) do nothing");
  await q("select * from lab_cftls.t where id=1 for update");
  for (let i = 0; i < 10; i++)
    await q("update lab_cftls.t set v=v+1 where id=1");
  await q("commit");
  out.lockHold10Ms = r1(performance.now() - s);
  try {
    const r = await q(
      "select ssl, version, cipher from pg_stat_ssl where pid = pg_backend_pid()",
    );
    out.pg_stat_ssl = r[0];
  } catch (e) {
    out.pg_stat_ssl = "err " + e.message;
  }
}

async function viaPg(cfg, out) {
  const c = new Client(cfg);
  let s = performance.now();
  await c.connect();
  out.connectMs = r1(performance.now() - s);
  await measure(async (sql) => (await c.query(sql)).rows, out);
  await c.end();
}
async function viaPostgresJs(url, ssl, out) {
  const sql = postgres(url, {
    ssl,
    max: 1,
    fetch_types: false,
    prepare: false,
  });
  let s = performance.now();
  await sql.unsafe("select 1");
  out.connectMs = r1(performance.now() - s); // connect + first query
  await measure(async (q) => await sql.unsafe(q), out);
  await sql.end();
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const v = u.searchParams.get("v");
    const out = { variant: v, colo: req.cf?.colo };
    const t0 = Date.now();
    try {
      const sess = new URL(env.SESS_URL);
      const host = sess.hostname;
      if (v === "a-default")
        await viaPg(
          {
            connectionString: env.SESS_URL,
            ssl: { rejectUnauthorized: true, servername: host },
          },
          out,
        );
      else if (v === "a-ca")
        await viaPg(
          {
            connectionString: env.SESS_URL,
            ssl: { rejectUnauthorized: true, servername: host, ca: CA },
          },
          out,
        );
      else if (v === "a-direct-ca")
        await viaPg(
          {
            connectionString: env.DIRECT_HOST_URL,
            ssl: {
              rejectUnauthorized: true,
              servername: new URL(env.DIRECT_HOST_URL).hostname,
              ca: CA,
            },
          },
          out,
        );
      else if (v === "a-noverify")
        await viaPg(
          {
            connectionString: env.SESS_URL,
            ssl: { rejectUnauthorized: false },
          },
          out,
        );
      else if (v === "a-notls")
        await viaPg({ connectionString: env.SESS_URL, ssl: false }, out);
      else if (v === "b-require")
        await viaPostgresJs(env.SESS_URL, "require", out);
      else if (v === "b-verify-ca")
        await viaPostgresJs(
          env.SESS_URL,
          { rejectUnauthorized: true, ca: CA, servername: host },
          out,
        );
      else if (v === "b-verify-default")
        await viaPostgresJs(
          env.SESS_URL,
          { rejectUnauthorized: true, servername: host },
          out,
        );
      else if (v === "c-hd")
        await viaPg({ connectionString: env.HD.connectionString }, out);
      else if (v === "c-hd-pooler")
        await viaPg({ connectionString: env.HD_POOLER.connectionString }, out);
      else out.error = "unknown variant";
    } catch (e) {
      out.error = String((e && e.message) || e);
      out.errName = e && e.name;
      out.code = e && e.code;
    }
    out.wallMs = Date.now() - t0;
    return Response.json(out);
  },
};
```

### `lab-drain-tls/lib/drain.mjs`

```js
import { PgBoss } from "pg-boss";

export const SCHEMA = "lab_pgdrain";
export const QUEUE = "lab_jobs";

export function makeBoss(url, extra = {}) {
  return new PgBoss({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    schema: SCHEMA,
    max: 2,
    supervise: false,
    schedule: false,
    registerInstance: false,
    ...extra,
  });
}

// work(job) simulates a handler; returns per-run metrics
export async function drain(
  url,
  {
    budgetMs = 20000,
    batchSize = 10,
    work = async () => {},
    bossExtra = {},
    abandonAfter = 0,
  } = {},
) {
  const t0 = performance.now();
  const boss = makeBoss(url, bossExtra);
  boss.on("error", () => {});
  const m = {
    startMs: 0,
    fetchMs: [],
    completeMs: [],
    jobs: 0,
    batches: 0,
    ids: [],
    stopMs: 0,
  };
  let s = performance.now();
  await boss.start();
  m.startMs = performance.now() - s;
  const deadline = t0 + budgetMs;
  while (performance.now() < deadline) {
    s = performance.now();
    const jobs = await boss.fetch(QUEUE, { batchSize });
    m.fetchMs.push(performance.now() - s);
    if (!jobs.length) break;
    m.batches++;
    const okIds = [];
    for (const j of jobs) {
      if (abandonAfter && m.jobs >= abandonAfter) {
        m.ids.push(j.id);
        m.jobs++;
        continue;
      } // fetched, never settled
      try {
        await work(j);
        okIds.push(j.id);
      } catch {
        await boss.fail(QUEUE, j.id);
        continue;
      }
      m.ids.push(j.id);
    }
    if (abandonAfter) {
      process.stdout.write(JSON.stringify({ abandoned: m.ids }) + "\n");
      process.exit(0);
    }
    s = performance.now();
    await boss.complete(QUEUE, okIds); // only jobs whose work succeeded
    m.completeMs.push(performance.now() - s);
    m.jobs += jobs.length;
    if (jobs.length < batchSize) {
      /* keep looping until empty fetch */
    }
  }
  s = performance.now();
  await boss.stop({ graceful: false, wait: false });
  m.stopMs = performance.now() - s;
  m.totalMs = performance.now() - t0;
  return m;
}
```

### `lab-drain-tls/lib/env.mjs`

```js
import fs from "node:fs";
const txt = fs.readFileSync("<path-to-env-file>", "utf8");
function get(k) {
  const m = txt.match(new RegExp("^" + k + '="?([^"\\n]+)"?', "m"));
  return m && m[1].replace(/[?&]pgbouncer=true/, "");
}
export const TXN = get("DATABASE_URL"); // :6543
export const SESS = get("DIRECT_URL"); // :5432
```

### `lab-drain-tls/vercel-app/package.json`

```json
{
  "name": "fw-lab-pgdrain",
  "private": true,
  "type": "module",
  "dependencies": { "pg-boss": "12.38.0" }
}
```

### `lab-drain-tls/vercel-app/vercel.json`

```json
{ "regions": ["bom1"], "functions": { "api/*.mjs": { "maxDuration": 60 } } }
```

### `lab-drain-tls/vercel-app/api/drain.mjs`

```js
import { PgBoss } from "pg-boss";
const SCHEMA = "lab_pgdrain",
  QUEUE = "lab_jobs";
let coldFlag = true; // module scope survives warm invocations
const bossFor = (url) =>
  new PgBoss({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    schema: SCHEMA,
    max: 2,
    supervise: false,
    schedule: false,
    registerInstance: false,
  });
export default async function handler(req, res) {
  const t0 = performance.now();
  const q = new URL(req.url, "http://x").searchParams;
  const url =
    q.get("pool") === "txn" ? process.env.DATABASE_URL : process.env.DIRECT_URL;
  const seedN = +(q.get("seed") || 0),
    budgetMs = +(q.get("budget") || 20000),
    doSup = q.get("supervise") === "1";
  const cold = coldFlag;
  coldFlag = false;
  const out = {
    cold,
    region: process.env.VERCEL_REGION,
    pool: q.get("pool") || "session",
  };
  const boss = bossFor(url);
  boss.on("error", (e) => (out.err = e.message));
  let s = performance.now();
  await boss.start();
  out.startMs = Math.round(performance.now() - s);
  if (seedN) {
    s = performance.now();
    await boss.insert(
      QUEUE,
      Array.from({ length: seedN }, (_, i) => ({ data: { i } })),
    );
    out.seedMs = Math.round(performance.now() - s);
  }
  const dStart = performance.now();
  let jobs = 0,
    batches = 0;
  const fetchMs = [],
    completeMs = [];
  while (performance.now() - t0 < budgetMs) {
    s = performance.now();
    const js = await boss.fetch(QUEUE, { batchSize: 10 });
    fetchMs.push(performance.now() - s);
    if (!js.length) break;
    batches++;
    s = performance.now();
    await boss.complete(
      QUEUE,
      js.map((j) => j.id),
    );
    completeMs.push(performance.now() - s);
    jobs += js.length;
  }
  out.drainMs = Math.round(performance.now() - dStart);
  out.jobs = jobs;
  out.batches = batches;
  const avg = (a) =>
    a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : 0;
  out.fetchAvgMs = avg(fetchMs);
  out.completeAvgMs = avg(completeMs);
  out.perJobMs = jobs ? +(out.drainMs / jobs).toFixed(1) : null;
  if (doSup) {
    s = performance.now();
    await boss.supervise(QUEUE);
    out.superviseMs = Math.round(performance.now() - s);
  }
  s = performance.now();
  await boss.stop({ graceful: false });
  out.stopMs = Math.round(performance.now() - s);
  out.totalMs = Math.round(performance.now() - t0);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(out));
}
```

## `lab-netlify-aw/`

### `lab-netlify-aw/dbadmin.mjs`

```js
import pg from "pg";
const c = new pg.Client({
  connectionString: process.env.PROBE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();
const cmd = process.argv[2];
if (cmd === "up") {
  await c.query("CREATE SCHEMA IF NOT EXISTS lab_naw");
  await c.query(
    "CREATE TABLE IF NOT EXISTS lab_naw.events(id bigserial primary key, run text, kind text, attempt int, note jsonb, region text, ts timestamptz default clock_timestamp())",
  );
  await c.query(
    "CREATE TABLE IF NOT EXISTS lab_naw.effects(id bigserial primary key, run text, tag text, ts timestamptz default clock_timestamp())",
  );
  await c.query(
    "CREATE TABLE IF NOT EXISTS lab_naw.orders(id bigserial primary key, run text)",
  );
  await c.query(
    "CREATE TABLE IF NOT EXISTS lab_naw.account(id int primary key, balance bigint, version int)",
  );
  await c.query(
    "INSERT INTO lab_naw.account VALUES (1,1000,0),(2,1000,0) ON CONFLICT DO NOTHING",
  );
} else if (cmd === "down") {
  await c.query("DROP SCHEMA IF EXISTS lab_naw CASCADE");
  const r = await c.query(
    "select nspname from pg_namespace where nspname like 'lab_naw%'",
  );
  console.log("remaining lab_naw schemas:", r.rowCount);
} else if (cmd === "q") {
  const r = await c.query(process.argv[3]);
  console.table(r.rows);
}
await c.end();
```

### `lab-netlify-aw/netlify.toml`

```toml
[build]
  publish = "public"
[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"
  external_node_modules = ["pg"]
```

### `lab-netlify-aw/package.json`

```json
{
  "name": "lab-netlify",
  "version": "1.0.0",
  "description": "",
  "main": "index.js",
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "type": "commonjs",
  "dependencies": {
    "@netlify/async-workloads": "^0.0.106",
    "@netlify/functions": "^6.0.3",
    "@upstash/qstash": "^2.12.1",
    "@upstash/workflow": "^1.5.0",
    "inngest": "^4.26.2",
    "pg": "^8.23.1",
    "zod": "^4.6.7"
  }
}
```

### `lab-netlify-aw/lib/db.mjs`

```js
import pg from "pg";
export const now = () => performance.now();
export async function connect() {
  const c = new pg.Client({
    connectionString: process.env.PROBE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  return c;
}
export async function log(run, kind, note = {}, attempt = null) {
  const c = await connect();
  try {
    await c.query(
      "INSERT INTO lab_naw.events(run,kind,attempt,note,region) VALUES ($1,$2,$3,$4,$5)",
      [run, kind, attempt, JSON.stringify(note), process.env.AWS_REGION],
    );
  } finally {
    await c.end();
  }
}
export async function q(sql, params) {
  const c = await connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}
```

### `lab-netlify-aw/lib/handler.mjs`

```js
import { log, q, connect, now } from "./db.mjs";
const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const p95 = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
};
const r1 = (x) => Math.round(x * 10) / 10;

export async function handle(event) {
  const { eventName, eventId, eventData = {}, attempt, step } = event;
  const run = eventData.run;
  await log(run, "invoke", { eventName, eventId }, attempt);
  switch (eventName.toLowerCase()) {
    case "lat":
      await log(run, "start", { i: eventData.i }, attempt);
      return;
    case "conc":
      await log(run, "start", { i: eventData.i }, attempt);
      await new Promise((r) => setTimeout(r, 2000));
      await log(run, "end", { i: eventData.i }, attempt);
      return;
    case "delay":
      await log(run, "start", { target: eventData.target }, attempt);
      return;
    case "retry-once":
    case "retry-always":
      await log(run, "start", {}, attempt);
      await q("INSERT INTO lab_naw.effects(run,tag) VALUES ($1,$2)", [
        run,
        "side-attempt-" + attempt,
      ]);
      if (eventName.toLowerCase() === "retry-always" || attempt === 0)
        throw new Error("boom attempt " + attempt);
      await log(run, "done", {}, attempt);
      return;
    case "sleep": {
      await step.run("before", () => log(run, "before-sleep", {}, attempt));
      await step.sleep("nap", eventData.sleep ?? "10s");
      await step.run("after", () => log(run, "after-sleep", {}, attempt));
      return;
    }
    case "multistep": {
      await step.run("s1", async () => {
        await q("INSERT INTO lab_naw.effects(run,tag) VALUES ($1,'s1')", [run]);
        await log(run, "s1-body", {}, attempt);
      });
      await step.run("s2", async () => {
        const n = (
          await q(
            "INSERT INTO lab_naw.effects(run,tag) VALUES ($1,'s2-try') RETURNING (SELECT count(*) FROM lab_naw.effects WHERE run=$1 AND tag='s2-try') n",
            [run],
          )
        )[0].n;
        await log(run, "s2-body", { try: Number(n) }, attempt);
        if (Number(n) === 1) throw new Error("s2 first try crash");
      });
      await step.run("s3", async () => {
        await q("INSERT INTO lab_naw.effects(run,tag) VALUES ($1,'s3')", [run]);
        await log(run, "s3-body", {}, attempt);
      });
      await log(run, "end", {}, attempt);
      return;
    }
    case "db": {
      const c = await connect();
      const out = {};
      try {
        const s1 = [];
        for (let i = 0; i < 50; i++) {
          const t = now();
          await c.query("SELECT 1");
          s1.push(now() - t);
        }
        out.select1 = {
          medianMs: r1(med(s1)),
          p95Ms: r1(p95(s1)),
          minMs: r1(Math.min(...s1)),
          maxMs: r1(Math.max(...s1)),
        };
        const holds = [];
        for (let i = 0; i < 10; i++) {
          const t = now();
          await c.query("BEGIN");
          const r = await c.query(
            "SELECT id, balance, version FROM lab_naw.account WHERE id=1 FOR UPDATE",
          );
          const v = r.rows[0].version;
          await c.query("SELECT balance FROM lab_naw.account WHERE id=2");
          await c.query("SELECT count(*) FROM lab_naw.account");
          await c.query(
            "UPDATE lab_naw.account SET balance=balance+1, version=version+1 WHERE id=1 AND version=$1",
            [v],
          );
          await c.query(
            "UPDATE lab_naw.account SET balance=balance-1 WHERE id=2",
          );
          await c.query("SELECT balance FROM lab_naw.account WHERE id=1");
          await c.query("SELECT balance FROM lab_naw.account WHERE id=2");
          await c.query("SELECT 1");
          await c.query("SELECT now()");
          await c.query("COMMIT");
          holds.push(now() - t);
        }
        out.lockHold = {
          medianMs: r1(med(holds)),
          p95Ms: r1(p95(holds)),
          rawMs: holds.map(r1),
        };
      } finally {
        await c.end();
      }
      await log(run, "dbresult", out, attempt);
      return;
    }
    case "dual": {
      const rows = await q(
        "SELECT count(*)::int n FROM lab_naw.orders WHERE run=$1",
        [run],
      );
      await log(run, "start", { orderRowVisible: rows[0].n }, attempt);
      return;
    }
    case "long":
    case "long-bg": {
      const ms = eventData.ms;
      await step.run("long-step", async () => {
        await log(run, "step-begin", { ms }, attempt);
        await new Promise((r) => setTimeout(r, ms));
        await log(run, "step-end", { ms }, attempt);
      });
      await log(run, "end", {}, attempt);
      return;
    }
  }
}
```

### `lab-netlify-aw/netlify/functions/send.mjs`

```js
import { AsyncWorkloadsClient } from "@netlify/async-workloads";
import { connect, log, q } from "../../lib/db.mjs";
export default async (req) => {
  const u = new URL(req.url);
  const p = (k, d) => u.searchParams.get(k) ?? d;
  const ev = p("ev", "lat");
  const n = +p("n", 1);
  const gap = +p("gap", 300);
  const par = p("par", "0") === "1";
  const run = p("run", ev + "-" + Date.now());
  const origin = p("src", "fn");
  const client = new AsyncWorkloadsClient();
  const sendOne = async (i) => {
    const data = { run: `${run}`, i, ms: +p("ms", 0) };
    const opts = { data };
    if (ev === "delay") {
      opts.delayUntil = Date.now() + +p("delayMs", 30000);
      data.target = opts.delayUntil;
    }
    await log(run, "sent-before", { i, src: origin });
    const t = performance.now();
    const res = await client.send(ev, opts);
    await log(run, "sent-after", {
      i,
      rttMs: Math.round(performance.now() - t),
      res,
    });
  };
  if (u.searchParams.get("mode") === "dual-a") {
    await q("INSERT INTO lab_naw.orders(run) VALUES ($1)", [run]); // committed
    await log(run, "committed-before-send", {});
    throw new Error("crash before send");
  }
  if (u.searchParams.get("mode") === "dual-b") {
    const c = await connect();
    try {
      await c.query("BEGIN");
      await c.query("INSERT INTO lab_naw.orders(run) VALUES ($1)", [run]);
      await sendOne(0);
      await c.query("ROLLBACK");
      await log(run, "rolled-back", {});
    } finally {
      await c.end();
    }
    return Response.json({ run, mode: "dual-b" });
  }
  if (par) await Promise.all(Array.from({ length: n }, (_, i) => sendOne(i)));
  else
    for (let i = 0; i < n; i++) {
      await sendOne(i);
      await new Promise((r) => setTimeout(r, gap));
    }
  return Response.json({ run, n });
};
export const config = { path: "/api/send" };
```

### `lab-netlify-aw/netlify/functions/wl-long-background.mjs`

```js
import { asyncWorkloadFn } from "@netlify/async-workloads";
import { handle } from "../../lib/handler.mjs";
export default asyncWorkloadFn(handle);
export const asyncWorkloadConfig = { events: ["long-bg"] };
```

### `lab-netlify-aw/netlify/functions/wl-main.mjs`

```js
import { asyncWorkloadFn } from "@netlify/async-workloads";
import { handle } from "../../lib/handler.mjs";
export default asyncWorkloadFn(handle);
export const asyncWorkloadConfig = {
  events: [
    "lat",
    "conc",
    "delay",
    "retry-once",
    "retry-always",
    "sleep",
    "multistep",
    "db",
    "dual",
    "long",
  ],
};
```

### `lab-netlify-aw/netlify/lib/lab.cjs`

```js
const pg = require("pg");
const client = () =>
  new pg.Client({
    connectionString: process.env.PROBE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
async function ev(run, kind, note = {}) {
  const c = client();
  await c.connect();
  try {
    await c.query(
      "INSERT INTO lab_nbg.events(run, kind, note, region) VALUES ($1,$2,$3,$4)",
      [run, kind, JSON.stringify(note), process.env.AWS_REGION],
    );
  } finally {
    await c.end();
  }
}
module.exports = { client, ev };
```

### `lab-netlify-aw/netlify/lib/lab.mjs`

```js
import pg from "pg";
export const client = () =>
  new pg.Client({
    connectionString: process.env.PROBE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
export async function ev(run, kind, note = {}) {
  const c = client();
  await c.connect();
  try {
    const r = await c.query(
      "INSERT INTO lab_nbg.events(run, kind, note, aws_req, region) VALUES ($1,$2,$3,$4,$5) RETURNING id, ts",
      [
        run,
        kind,
        JSON.stringify(note),
        process.env._X_AMZN_TRACE_ID ?? null,
        process.env.AWS_REGION,
      ],
    );
    return r.rows[0];
  } finally {
    await c.end();
  }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
```

## `lab-netlify-aw2/`

The lab repository name and deploy key are not recorded here. Workload logic is in `lib/handler.mjs`.

### `lab-netlify-aw2/dbadmin.mjs`

```js
import pg from "pg";
const c = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();
const cmd = process.argv[2];
if (cmd === "up") {
  await c.query("CREATE SCHEMA IF NOT EXISTS lab_naw2");
  await c.query(
    "CREATE TABLE IF NOT EXISTS lab_naw2.events(id bigserial primary key, run text, kind text, attempt int, note jsonb, region text, ts timestamptz default clock_timestamp())",
  );
  await c.query(
    "CREATE TABLE IF NOT EXISTS lab_naw2.effects(id bigserial primary key, run text, tag text, ts timestamptz default clock_timestamp())",
  );
  await c.query(
    "CREATE TABLE IF NOT EXISTS lab_naw2.orders(id bigserial primary key, run text)",
  );
  await c.query(
    "CREATE TABLE IF NOT EXISTS lab_naw2.account(id int primary key, balance bigint, version int)",
  );
  await c.query(
    "INSERT INTO lab_naw2.account VALUES (1,1000,0),(2,1000,0) ON CONFLICT DO NOTHING",
  );
} else if (cmd === "down") {
  await c.query("DROP SCHEMA IF EXISTS lab_naw2 CASCADE");
  const r = await c.query(
    "select nspname from pg_namespace where nspname like 'lab_naw2%'",
  );
  console.log("remaining lab_naw2 schemas:", r.rowCount);
} else if (cmd === "q") {
  const r = await c.query(process.argv[3]);
  console.table(r.rows);
}
await c.end();
```

### `lab-netlify-aw2/netlify.toml`

```toml
[build]
  publish = "public"
[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"
  external_node_modules = ["pg"]
```

### `lab-netlify-aw2/package.json`

```json
{
  "name": "fw-lab-async-workloads",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "@netlify/async-workloads": "^0.0.106",
    "@netlify/functions": "^6.0.3",
    "pg": "^8.23.1"
  }
}
```

### `lab-netlify-aw2/lib/db.mjs`

```js
import pg from "pg";
export const now = () => performance.now();
export async function connect() {
  const c = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  return c;
}
export async function log(run, kind, note = {}, attempt = null) {
  const c = await connect();
  try {
    await c.query(
      "INSERT INTO lab_naw2.events(run,kind,attempt,note,region) VALUES ($1,$2,$3,$4,$5)",
      [run, kind, attempt, JSON.stringify(note), process.env.AWS_REGION],
    );
  } finally {
    await c.end();
  }
}
export async function q(sql, params) {
  const c = await connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}
```

### `lab-netlify-aw2/lib/handler.mjs`

```js
import { log, q, connect, now } from "./db.mjs";
const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const p95 = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
};
const r1 = (x) => Math.round(x * 10) / 10;

export async function handle(event) {
  const { eventName, eventId, eventData = {}, attempt, step: rawStep } = event;
  const step = {
    sleep: (...a) => rawStep.sleep(...a),
    run: (id, fn) =>
      rawStep.run(id, async () => {
        await fn();
        return { ok: true };
      }),
  };
  const run = eventData.run;
  await log(run, "invoke", { eventName, eventId }, attempt);
  switch (eventName.toLowerCase()) {
    case "lat":
      await log(run, "start", { i: eventData.i }, attempt);
      return;
    case "conc":
      await log(run, "start", { i: eventData.i }, attempt);
      await new Promise((r) => setTimeout(r, 2000));
      await log(run, "end", { i: eventData.i }, attempt);
      return;
    case "delay":
      await log(run, "start", { target: eventData.target }, attempt);
      return;
    case "retry-once":
    case "retry-always":
      await log(run, "start", {}, attempt);
      await q("INSERT INTO lab_naw2.effects(run,tag) VALUES ($1,$2)", [
        run,
        "side-attempt-" + attempt,
      ]);
      if (eventName.toLowerCase() === "retry-always" || attempt === 0)
        throw new Error("boom attempt " + attempt);
      await log(run, "done", {}, attempt);
      return;
    case "sleep": {
      await step.run("before", () => log(run, "before-sleep", {}, attempt));
      await step.sleep("nap", eventData.sleep ?? "10s");
      await step.run("after", () => log(run, "after-sleep", {}, attempt));
      return;
    }
    case "multistep": {
      await step.run("s1", async () => {
        await q("INSERT INTO lab_naw2.effects(run,tag) VALUES ($1,'s1')", [
          run,
        ]);
        await log(run, "s1-body", {}, attempt);
      });
      await step.run("s2", async () => {
        await q("INSERT INTO lab_naw2.effects(run,tag) VALUES ($1,'s2-try')", [
          run,
        ]);
        const n = (
          await q(
            "SELECT count(*)::int n FROM lab_naw2.effects WHERE run=$1 AND tag='s2-try'",
            [run],
          )
        )[0].n;
        await log(run, "s2-body", { try: Number(n) }, attempt);
        if (Number(n) === 1) throw new Error("s2 first try crash");
      });
      await step.run("s3", async () => {
        await q("INSERT INTO lab_naw2.effects(run,tag) VALUES ($1,'s3')", [
          run,
        ]);
        await log(run, "s3-body", {}, attempt);
      });
      await log(run, "end", {}, attempt);
      return;
    }
    case "db": {
      const c = await connect();
      const out = {};
      try {
        const s1 = [];
        for (let i = 0; i < 50; i++) {
          const t = now();
          await c.query("SELECT 1");
          s1.push(now() - t);
        }
        out.select1 = {
          medianMs: r1(med(s1)),
          p95Ms: r1(p95(s1)),
          minMs: r1(Math.min(...s1)),
          maxMs: r1(Math.max(...s1)),
        };
        const holds = [];
        for (let i = 0; i < 10; i++) {
          const t = now();
          await c.query("BEGIN");
          const r = await c.query(
            "SELECT id, balance, version FROM lab_naw2.account WHERE id=1 FOR UPDATE",
          );
          const v = r.rows[0].version;
          await c.query("SELECT balance FROM lab_naw2.account WHERE id=2");
          await c.query("SELECT count(*) FROM lab_naw2.account");
          await c.query(
            "UPDATE lab_naw2.account SET balance=balance+1, version=version+1 WHERE id=1 AND version=$1",
            [v],
          );
          await c.query(
            "UPDATE lab_naw2.account SET balance=balance-1 WHERE id=2",
          );
          await c.query("SELECT balance FROM lab_naw2.account WHERE id=1");
          await c.query("SELECT balance FROM lab_naw2.account WHERE id=2");
          await c.query("SELECT 1");
          await c.query("SELECT now()");
          await c.query("COMMIT");
          holds.push(now() - t);
        }
        out.lockHold = {
          medianMs: r1(med(holds)),
          p95Ms: r1(p95(holds)),
          rawMs: holds.map(r1),
        };
      } finally {
        await c.end();
      }
      await log(run, "dbresult", out, attempt);
      return;
    }
    case "dual": {
      const rows = await q(
        "SELECT count(*)::int n FROM lab_naw2.orders WHERE run=$1",
        [run],
      );
      await log(run, "start", { orderRowVisible: rows[0].n }, attempt);
      return;
    }
    case "long":
    case "long-bg": {
      const ms = eventData.ms;
      await step.run("long-step", async () => {
        await log(run, "step-begin", { ms }, attempt);
        await new Promise((r) => setTimeout(r, ms));
        await log(run, "step-end", { ms }, attempt);
      });
      await log(run, "end", {}, attempt);
      return;
    }
  }
}
```

### `lab-netlify-aw2/netlify/functions/send.mjs`

```js
import { AsyncWorkloadsClient } from "@netlify/async-workloads";
import { connect, log, q } from "../../lib/db.mjs";
export default async (req) => {
  const u = new URL(req.url);
  const p = (k, d) => u.searchParams.get(k) ?? d;
  const ev = p("ev", "lat");
  const n = +p("n", 1);
  const gap = +p("gap", 300);
  const par = p("par", "0") === "1";
  const run = p("run", ev + "-" + Date.now());
  const origin = p("src", "fn");
  const client = new AsyncWorkloadsClient();
  const sendOne = async (i) => {
    const data = {
      run: `${run}`,
      i,
      ms: +p("ms", 0),
      sleep: p("sleep", "10s"),
    };
    const opts = { data };
    if (ev === "delay") {
      opts.delayUntil = Date.now() + +p("delayMs", 30000);
      data.target = opts.delayUntil;
    }
    await log(run, "sent-before", { i, src: origin });
    const t = performance.now();
    const res = await client.send(ev, opts);
    await log(run, "sent-after", {
      i,
      rttMs: Math.round(performance.now() - t),
      res,
    });
  };
  if (u.searchParams.get("mode") === "dual-a") {
    await q("INSERT INTO lab_naw2.orders(run) VALUES ($1)", [run]); // committed
    await log(run, "committed-before-send", {});
    throw new Error("crash before send");
  }
  if (u.searchParams.get("mode") === "dual-b") {
    const c = await connect();
    try {
      await c.query("BEGIN");
      await c.query("INSERT INTO lab_naw2.orders(run) VALUES ($1)", [run]);
      await sendOne(0);
      await c.query("ROLLBACK");
      await log(run, "rolled-back", {});
    } finally {
      await c.end();
    }
    return Response.json({ run, mode: "dual-b" });
  }
  if (par) await Promise.all(Array.from({ length: n }, (_, i) => sendOne(i)));
  else
    for (let i = 0; i < n; i++) {
      await sendOne(i);
      await new Promise((r) => setTimeout(r, gap));
    }
  return Response.json({ run, n });
};
export const config = { path: "/api/send" };
```

### `lab-netlify-aw2/netlify/functions/wl-long-background.mjs`

```js
import { asyncWorkloadFn } from "@netlify/async-workloads";
import { handle } from "../../lib/handler.mjs";
export default asyncWorkloadFn(handle);
export const asyncWorkloadConfig = { events: ["long-bg"] };
```

### `lab-netlify-aw2/netlify/functions/wl-main.mjs`

```js
import { asyncWorkloadFn } from "@netlify/async-workloads";
import { handle } from "../../lib/handler.mjs";
export default asyncWorkloadFn(handle);
export const asyncWorkloadConfig = {
  events: [
    "lat",
    "conc",
    "delay",
    "retry-once",
    "retry-always",
    "sleep",
    "multistep",
    "db",
    "dual",
    "long",
  ],
};
```

## `lab-restate/`

### `lab-restate/package.json`

```json
{
  "name": "fw-lab-restate",
  "private": true,
  "type": "module",
  "dependencies": { "@restatedev/restate-sdk": "1.18.0", "pg": "^8.13.0" },
  "devDependencies": { "@types/pg": "^8", "typescript": "^5" }
}
```

### `lab-restate/vercel.json`

```json
{
  "regions": ["bom1"],
  "functions": { "api/restate.ts": { "maxDuration": 300 } },
  "rewrites": [
    { "source": "/api/restate/:path*", "destination": "/api/restate" }
  ]
}
```

### `lab-restate/api/restate.ts`

```ts
import * as restate from "@restatedev/restate-sdk/fetch";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  ssl: { rejectUnauthorized: false },
});
const q = (text: string, p: unknown[] = []) => pool.query(text, p);
const log = (kind: string, run: string, info: Record<string, unknown> = {}) =>
  q("insert into lab_rst.ev(kind,run,t_ms,info) values ($1,$2,$3,$4)", [
    kind,
    run,
    Date.now(),
    JSON.stringify(info),
  ]);
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

const lab = restate.service({
  name: "Lab",
  handlers: {
    ping: async (ctx: restate.Context, i: { run: string }) => {
      const t = Date.now();
      await log("ping.in", i.run, { t });
      return { t };
    },
    steps: async (ctx: restate.Context, i: { run: string }) => {
      await log("steps.enter", i.run);
      for (const s of [1, 2, 3]) {
        await ctx.run(`step${s}`, async () => {
          const t0 = Date.now();
          const per: number[] = [];
          for (let k = 0; k < 5; k++) {
            const a = Date.now();
            await q("select 1");
            per.push(Date.now() - a);
          }
          await log("steps.step", i.run, { s, t0, t1: Date.now(), per });
          return s;
        });
      }
      await log("steps.exit", i.run);
      return "ok";
    },
    flaky: async (ctx: restate.Context, i: { run: string }) => {
      await log("flaky.enter", i.run);
      await ctx.run("s1", async () => {
        await log("flaky.side", i.run, { s: 1 });
      });
      await ctx.run("s2", async () => {
        const r = await q(
          "insert into lab_rst.ev(kind,run,t_ms) values ('flaky.attempt',$1,$2) returning (select count(*) from lab_rst.ev where kind='flaky.attempt' and run=$1) c",
          [i.run, Date.now()],
        );
        if (Number(r.rows[0].c) <= 1) throw new Error("first attempt fails");
        await log("flaky.side", i.run, { s: 2 });
      });
      await ctx.run("s3", async () => {
        await log("flaky.side", i.run, { s: 3 });
      });
      return "ok";
    },
    sleeper: async (ctx: restate.Context, i: { run: string }) => {
      await log("sleep.enter", i.run);
      const before = Date.now();
      await ctx.sleep({ seconds: 10 });
      await log("sleep.after", i.run, { before });
      return "ok";
    },
    slow: async (ctx: restate.Context, i: { run: string; secs: number }) => {
      await log("slow.enter", i.run);
      await ctx.run("slow", async () => {
        await log("slow.start", i.run, { secs: i.secs });
        await sleepMs(i.secs * 1000);
        await log("slow.end", i.run);
      });
      return "ok";
    },
    idem: async (ctx: restate.Context, i: { run: string }) => {
      await ctx.run("w", async () => {
        await log("idem.exec", i.run);
      });
      return "ok";
    },
    dual: async (ctx: restate.Context, i: { run: string }) => {
      const r = await q(
        "select count(*)::int c from lab_rst.orders where id=$1",
        [i.run],
      );
      await log("dual.seen", i.run, { orderRowVisible: r.rows[0].c });
    },
    delayed: async (ctx: restate.Context, i: { run: string }) => {
      await log("delayed.in", i.run);
    },
    cron: async (ctx: restate.Context, i: { run: string; n: number }) => {
      await log("cron.tick", i.run, { n: i.n });
      if (i.n < 6)
        ctx
          .serviceSendClient<typeof lab>({ name: "Lab" })
          .cron(
            { run: i.run, n: i.n + 1 },
            restate.rpc.sendOpts({ delay: { seconds: 30 } }),
          );
    },
  },
});

const endpoint = restate.createEndpointHandler({ services: [lab] });
export const POST = (r: Request) => endpoint(r);
export const GET = (r: Request) => endpoint(r);
```

### `lab-restate/lib.mjs`

```js
import fs from "fs";
import pg from "pg";
export const ING = "https://<environment-id>.env.eu.restate.cloud:8080";
export const TOK = process.env.RESTATE_KEY;
export const dbUrl = process.env.DATABASE_URL;
export const db = () =>
  new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });
export async function call(path, body, headers = {}) {
  const t0 = Date.now();
  const r = await fetch(ING + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + TOK,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  return { status: r.status, ms: Date.now() - t0, t0, txt };
}
export const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
export const p95 = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.ceil(s.length * 0.95) - 1];
};
export async function evs(run) {
  const c = db();
  await c.connect();
  const r = await c.query(
    "select kind,t_ms::float8 t,info from lab_rst.ev where run=$1 order by id",
    [run],
  );
  await c.end();
  return r.rows;
}
```

### `lab-restate/setup.mjs`

```js
import pg from "pg";
import fs from "fs";
const url = process.env.DATABASE_URL;
export const c = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});
export const dbUrl = url;
await c.connect();
const cmd = process.argv[2];
if (cmd === "up") {
  await c.query(
    "create schema if not exists lab_rst; create table if not exists lab_rst.ev(id bigserial primary key, kind text, run text, t_ms bigint, info jsonb); create table if not exists lab_rst.orders(id text primary key)",
  );
}
if (cmd === "down") {
  await c.query("drop schema lab_rst cascade");
  console.log(
    (
      await c.query(
        "select nspname from pg_namespace where nspname like 'lab_rst%'",
      )
    ).rowCount,
    "rows",
  );
}
await c.end();
```

### `lab-restate/m1.mjs`

```js
import { call, med, p95, evs } from "./lib.mjs";
const e2e = [],
  hop = [];
await call("/Lab/ping", { run: "warm" });
for (let i = 0; i < 20; i++) {
  const run = "p" + i;
  const r = await call("/Lab/ping", { run });
  e2e.push(r.ms);
  const e = await evs(run);
  hop.push(e[0].t - r.t0);
  console.log(i, r.status, r.ms, "laptop->fn_entry", e[0].t - r.t0);
}
console.log(
  "e2e median",
  med(e2e),
  "p95",
  p95(e2e),
  "min",
  Math.min(...e2e),
  "max",
  Math.max(...e2e),
);
console.log("laptop->fn entry median", med(hop), "p95", p95(hop));
// baseline direct to vercel
const d = [];
for (let i = 0; i < 20; i++) {
  const t = Date.now();
  await fetch("https://fw-lab-restate.vercel.app/api/restate/discover");
  d.push(Date.now() - t);
}
console.log("direct vercel discover median", med(d), "p95", p95(d));
// baseline direct to restate ingress health
const h = [];
for (let i = 0; i < 20; i++) {
  const t = Date.now();
  await fetch(
    "https://<environment-id>.env.eu.restate.cloud:8080/restate/health",
  );
  h.push(Date.now() - t);
}
console.log("ingress health median", med(h), "p95", p95(h));
```

### `lab-restate/m2.mjs`

```js
import { call, db, evs } from "./lib.mjs";
const show = (rows) =>
  rows
    .map(
      (r) =>
        `${r.kind} ${r.t}${r.info && Object.keys(r.info).length ? " " + JSON.stringify(r.info) : ""}`,
    )
    .join("\n");
// 2 steps
let run = "steps" + Date.now();
let r = await call("/Lab/steps", { run });
console.log("== M2 steps", r.status, r.ms + "ms");
let e = await evs(run);
const t0 = e[0].t;
for (const x of e)
  console.log(
    x.kind,
    "+" + (x.t - t0),
    x.info.s
      ? `step${x.info.s} dur=${x.info.t1 - x.info.t0} per=${x.info.per}`
      : "",
  );
console.log(
  "fn invocations (enter rows):",
  e.filter((x) => x.kind === "steps.enter").length,
);
// 3 flaky
run = "flaky" + Date.now();
r = await call("/Lab/flaky", { run });
console.log("== M3 flaky", r.status, r.ms + "ms");
e = await evs(run);
const f0 = e[0].t;
for (const x of e)
  console.log(x.kind, "+" + (x.t - f0), JSON.stringify(x.info));
console.log(
  "enters",
  e.filter((x) => x.kind === "flaky.enter").length,
  "side rows by step:",
  JSON.stringify(e.filter((x) => x.kind === "flaky.side").map((x) => x.info.s)),
);
// 4 sleep
run = "sleep" + Date.now();
r = await call("/Lab/sleeper", { run });
console.log("== M4 sleep", r.status, r.ms + "ms");
e = await evs(run);
const s0 = e[0].t;
for (const x of e)
  console.log(x.kind, "+" + (x.t - s0), JSON.stringify(x.info));
// 6 idempotency
run = "idem" + Date.now();
const h = { "idempotency-key": run };
const a = await call("/Lab/idem", { run }, h),
  b = await call("/Lab/idem", { run }, h);
e = await evs(run);
console.log(
  "== M6 idem",
  a.status,
  a.ms,
  a.txt,
  "|",
  b.status,
  b.ms,
  b.txt,
  "exec rows:",
  e.filter((x) => x.kind === "idem.exec").length,
);
// 7 dual write
const c = db();
await c.connect();
const id1 = "dual-commit-" + Date.now();
await c.query("insert into lab_rst.orders(id) values ($1)", [id1]);
console.log(
  "== M7a committed row",
  id1,
  "then simulated crash before calling Restate; invocations for it:",
  (await evs(id1)).length,
);
const id2 = "dual-rollback-" + Date.now();
await c.query("begin");
await c.query("insert into lab_rst.orders(id) values ($1)", [id2]);
const sr = await fetch((await import("./lib.mjs")).ING + "/Lab/dual/send", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: "Bearer " + (await import("./lib.mjs")).TOK,
  },
  body: JSON.stringify({ run: id2 }),
});
console.log("M7b send inside open tx status", sr.status);
await new Promise((r) => setTimeout(r, 4000));
await c.query("rollback");
console.log(
  "M7b order row after rollback:",
  (
    await c.query("select count(*)::int c from lab_rst.orders where id=$1", [
      id2,
    ])
  ).rows[0].c,
);
e = await evs(id2);
console.log(
  "M7b handler ran:",
  e.map((x) => x.kind + " " + JSON.stringify(x.info)),
);
await c.end();
```

### `lab-restate/m5.mjs`

```js
import { ING, TOK } from "./lib.mjs";
for (const s of [30, 290, 310]) {
  const run = "slow" + s + "-" + Date.now();
  const r = await fetch(ING + "/Lab/slow/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + TOK,
    },
    body: JSON.stringify({ run, secs: s }),
  });
  console.log(run, r.status, Date.now(), await r.text());
}
```

### `lab-restate/m8.mjs`

```js
import { ING, TOK, evs } from "./lib.mjs";
const run = "delay" + Date.now();
const t = Date.now();
const r = await fetch(ING + "/Lab/delayed/send?delay=30s", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: "Bearer " + TOK,
  },
  body: JSON.stringify({ run }),
});
console.log("== M8 send", r.status, Date.now() - t, "ms ack");
await new Promise((r) => setTimeout(r, 40000));
const e = await evs(run);
console.log(
  "fired at +",
  e[0] ? e[0].t - t : "never",
  "ms after send (target 30000)",
);
```

### `lab-restate/m9.mjs`

```js
import { ING, TOK } from "./lib.mjs";
const run = "cron" + Date.now();
const t = Date.now();
const r = await fetch(ING + "/Lab/cron/send", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: "Bearer " + TOK,
  },
  body: JSON.stringify({ run, n: 1 }),
});
console.log("== M9 cron start", r.status, run, t);
```

### `lab-restate/hop.mjs`

```js
import fs from "fs";
import { db, med, p95 } from "./lib.mjs";
const inv = JSON.parse(fs.readFileSync("ping.json", "utf8")).slice(-20);
const c = db();
await c.connect();
const e = (
  await c.query(
    "select run,t_ms::float8 t from lab_rst.ev where kind='ping.in' and run ~ '^p[0-9]+$' order by id",
  )
).rows.slice(-20);
await c.end();
const hop = inv.map((x, i) => e[i].t - x.r),
  tot = inv.map((x) => x.d - x.r),
  ing = inv.map((x) => x.r - x.c);
console.log(
  "restate running_at -> fn entry: median",
  med(hop),
  "p95",
  p95(hop),
  "min",
  Math.min(...hop),
);
console.log(
  "restate running_at -> completed_at: median",
  med(tot),
  "p95",
  p95(tot),
);
console.log("created->running median", med(ing));
```
