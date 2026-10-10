import { createHash } from "node:crypto";

interface StoreEntry {
  value: string;
  expiry?: number;
}

class InMemoryRedisEdge {
  private store = new Map<string, StoreEntry>();
  private scripts = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.getValidValue(key);
  }

  async set(
    key: string,
    value: string | number,
    opts?: { nx?: boolean; xx?: boolean; px?: number; ex?: number },
  ): Promise<string | null> {
    this.cleanupExpiredKey(key);
    if (opts?.nx && this.store.has(key)) {
      return null;
    }
    if (opts?.xx && !this.store.has(key)) {
      return null;
    }

    const entry: StoreEntry = { value: String(value) };
    if (opts?.px !== undefined) {
      entry.expiry = Date.now() + opts.px;
    } else if (opts?.ex !== undefined) {
      entry.expiry = Date.now() + opts.ex * 1000;
    }

    this.store.set(key, entry);
    return "OK";
  }

  async incr(key: string): Promise<number> {
    return this.incrby(key, 1);
  }

  async incrby(key: string, amount: number): Promise<number> {
    this.cleanupExpiredKey(key);
    const entry = this.store.get(key);
    const current = entry ? Number.parseInt(entry.value, 10) || 0 : 0;
    const next = current + amount;
    this.store.set(key, { value: String(next), expiry: entry?.expiry });
    return next;
  }

  async decr(key: string): Promise<number> {
    return this.incrby(key, -1);
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this.pexpire(key, seconds * 1000);
  }

  async pexpire(key: string, ms: number): Promise<number> {
    this.cleanupExpiredKey(key);
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.expiry = Date.now() + ms;
    return 1;
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.store.delete(key)) deleted += 1;
    }
    return deleted;
  }

  async exists(...keys: string[]): Promise<number> {
    let present = 0;
    for (const key of keys) {
      if (this.getValidValue(key) !== null) present += 1;
    }
    return present;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const existing = new Set(this.readSet(key));
    const before = existing.size;
    for (const member of members) existing.add(member);
    this.store.set(key, { value: JSON.stringify([...existing]) });
    return existing.size - before;
  }

  async smembers(key: string): Promise<string[]> {
    return this.readSet(key);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const existing = new Set(this.readSet(key));
    const before = existing.size;
    for (const member of members) existing.delete(member);
    if (existing.size === 0) {
      this.store.delete(key);
    } else {
      this.store.set(key, { value: JSON.stringify([...existing]) });
    }
    return before - existing.size;
  }

  async hset(key: string, values: Record<string, unknown>): Promise<number> {
    const existing = this.readHash(key);
    let added = 0;
    for (const [field, val] of Object.entries(values)) {
      if (!(field in existing)) added += 1;
      existing[field] = String(val);
    }
    this.store.set(key, { value: JSON.stringify(existing) });
    return added;
  }

  async hget(key: string, field: string): Promise<string | null> {
    const existing = this.readHash(key);
    return field in existing ? existing[field] : null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.readHash(key);
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const existing = this.readHash(key);
    let removed = 0;
    for (const field of fields) {
      if (field in existing) {
        delete existing[field];
        removed += 1;
      }
    }
    if (Object.keys(existing).length === 0) {
      this.store.delete(key);
    } else {
      this.store.set(key, { value: JSON.stringify(existing) });
    }
    return removed;
  }

  async scriptLoad(script: string): Promise<string> {
    const sha = createHash("sha256").update(script).digest("hex").slice(0, 40);
    this.scripts.set(sha, script);
    return sha;
  }

  async evalsha(
    sha: string,
    keys: string[],
    args: Array<string | number>,
  ): Promise<unknown> {
    const cached = this.scripts.get(sha);
    if (cached) {
      return this.eval(cached, keys, args);
    }
    throw new Error("NOSCRIPT No matching script. Please use EVAL.");
  }

  async eval(
    script: string,
    keys: string[],
    args: Array<string | number>,
  ): Promise<unknown> {
    const sha = createHash("sha256").update(script).digest("hex").slice(0, 40);
    this.scripts.set(sha, script);

    if (script.includes("requestsInCurrentWindow") || keys.length >= 2) {
      const currentKey = keys[0];
      const previousKey = keys[1];
      const dynamicLimitKey = keys[2];

      let effectiveLimit = Number(args[0]);
      if (dynamicLimitKey) {
        const dyn = this.getValidValue(dynamicLimitKey);
        if (dyn !== null) effectiveLimit = Number(dyn);
      }

      const now = Number(args[1]);
      const windowMs = Number(args[2]);
      const incrementBy = Number(args[3] ?? 1);

      const currentCount = Number(this.getValidValue(currentKey) ?? "0");
      const previousRaw = Number(this.getValidValue(previousKey) ?? "0");
      const percentageInCurrent = (now % windowMs) / windowMs;
      const weightedPrevious = Math.floor(
        (1 - percentageInCurrent) * previousRaw,
      );

      if (
        incrementBy > 0 &&
        weightedPrevious + currentCount >= effectiveLimit
      ) {
        return [-1, effectiveLimit];
      }

      const newValue = await this.incrby(currentKey, incrementBy);
      if (newValue === incrementBy) {
        await this.pexpire(currentKey, windowMs * 2 + 1000);
      }
      return [effectiveLimit - (newValue + weightedPrevious), effectiveLimit];
    }

    const lower = script.toLowerCase();
    if (lower.includes('"del"') || lower.includes("'del'")) {
      if (this.getValidValue(keys[0]) === String(args[0])) {
        this.store.delete(keys[0]);
        return 1;
      }
      return 0;
    }

    if (lower.includes("incrby") || lower.includes('"incr"')) {
      const incrementBy = Number(args[2] ?? 1);
      const count = await this.incrby(keys[0], incrementBy);
      if (count === incrementBy && args[1] !== undefined) {
        await this.pexpire(keys[0], Number(args[1]));
      }
      return count;
    }

    return 0;
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  clear(): void {
    this.store.clear();
  }

  private getValidValue(key: string): string | null {
    this.cleanupExpiredKey(key);
    return this.store.get(key)?.value ?? null;
  }

  private cleanupExpiredKey(key: string): void {
    const entry = this.store.get(key);
    if (entry?.expiry !== undefined && Date.now() > entry.expiry) {
      this.store.delete(key);
    }
  }

  private readSet(key: string): string[] {
    const raw = this.getValidValue(key);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }

  private readHash(key: string): Record<string, string> {
    const raw = this.getValidValue(key);
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        const result: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          result[k] = String(v);
        }
        return result;
      }
      return {};
    } catch {
      return {};
    }
  }
}

const mockRedisEdge = new InMemoryRedisEdge();

export default mockRedisEdge;
