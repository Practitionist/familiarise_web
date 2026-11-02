/**
 * In-memory mock that mimics the Upstash Redis API for local development and tests.
 */

export const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

export const RENEW_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
  else
    return 0
  end
`;

/** Sets every key or none: answers the held keys, or an empty list after setting all. */
export const SLOT_BATCH_ACQUIRE_SCRIPT = `
  -- slot-batch-acquire
  local held = {}
  for _, k in ipairs(KEYS) do
    if redis.call("exists", k) == 1 then held[#held + 1] = k end
  end
  if #held > 0 then return held end
  for _, k in ipairs(KEYS) do
    redis.call("set", k, ARGV[1], "PX", ARGV[2])
  end
  return held
`;

/** Re-arms every key only when every key still carries the batch's value. */
export const SLOT_BATCH_RENEW_SCRIPT = `
  -- slot-batch-renew
  for _, k in ipairs(KEYS) do
    if redis.call("get", k) ~= ARGV[1] then return 0 end
  end
  for _, k in ipairs(KEYS) do redis.call("pexpire", k, ARGV[2]) end
  return 1
`;

/** Deletes each key still carrying the batch's value. */
export const SLOT_BATCH_RELEASE_SCRIPT = `
  -- slot-batch-release
  local n = 0
  for _, k in ipairs(KEYS) do
    if redis.call("get", k) == ARGV[1] then
      redis.call("del", k)
      n = n + 1
    end
  end
  return n
`;

interface StoreEntry {
  value: string;
  expiry?: number;
}

export class MockRedis {
  private store = new Map<string, StoreEntry>();

  async set(
    key: string,
    value: string,
    opts?: { nx?: boolean; px?: number; ex?: number },
  ): Promise<string | null> {
    this.cleanupExpiredKey(key);
    if (opts?.nx && this.store.has(key)) {
      return null;
    }

    const entry: StoreEntry = { value: String(value) };
    if (opts?.px) {
      entry.expiry = Date.now() + opts.px;
    } else if (opts?.ex) {
      entry.expiry = Date.now() + opts.ex * 1000;
    }

    this.store.set(key, entry);
    return "OK";
  }

  async get<T = string>(key: string): Promise<T | null> {
    return (this.getValidValue(key) as T | null) ?? null;
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
    }
    return count;
  }

  async exists(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      this.cleanupExpiredKey(key);
      if (this.store.has(key)) count++;
    }
    return count;
  }

  async incr(key: string): Promise<number> {
    this.cleanupExpiredKey(key);
    const entry = this.store.get(key);
    const value = (entry ? parseInt(entry.value, 10) || 0 : 0) + 1;
    this.store.set(key, { value: String(value), expiry: entry?.expiry });
    return value;
  }

  async decr(key: string): Promise<number> {
    this.cleanupExpiredKey(key);
    const entry = this.store.get(key);
    const value = (entry ? parseInt(entry.value, 10) || 0 : 0) - 1;
    this.store.set(key, { value: String(value), expiry: entry?.expiry });
    return value;
  }

  private readSet(key: string): string[] {
    const raw = this.getValidValue(key);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const existing = new Set(this.readSet(key));
    const before = existing.size;
    for (const m of members) existing.add(m);
    this.store.set(key, { value: JSON.stringify([...existing]) });
    return existing.size - before;
  }

  async smembers(key: string): Promise<string[]> {
    return this.readSet(key);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const existing = new Set(this.readSet(key));
    const before = existing.size;
    for (const m of members) existing.delete(m);
    if (existing.size === 0) this.store.delete(key);
    else this.store.set(key, { value: JSON.stringify([...existing]) });
    return before - existing.size;
  }

  async pexpire(key: string, ms: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.expiry = Date.now() + ms;
    return 1;
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async pttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return -2;
    if (entry.expiry === undefined) return -1;
    if (entry.expiry <= Date.now()) {
      this.store.delete(key);
      return -2;
    }
    return entry.expiry - Date.now();
  }

  /**
   * Direct handler for the three atomic Lua scripts used in the repository:
   * 1. compare-and-del (distributed lock release)
   * 2. compare-and-pexpire (distributed lock renewal)
   * 3. INCR + PEXPIRE (fixed-window rate-limit counter)
   */
  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    if (script.includes("-- slot-batch-acquire")) {
      const held = keys.filter((k) => this.getValidValue(k) !== null);
      if (held.length > 0) return held;
      for (const k of keys) {
        this.store.set(k, {
          value: String(args[0]),
          expiry: Date.now() + Number(args[1]),
        });
      }
      return [];
    }
    if (script.includes("-- slot-batch-renew")) {
      if (keys.some((k) => this.getValidValue(k) !== String(args[0]))) {
        return 0;
      }
      for (const k of keys) await this.pexpire(k, Number(args[1]));
      return 1;
    }
    if (script.includes("-- slot-batch-release")) {
      let released = 0;
      for (const k of keys) {
        if (this.getValidValue(k) === String(args[0])) {
          this.store.delete(k);
          released += 1;
        }
      }
      return released;
    }
    const lower = script.toLowerCase();
    if (lower.includes('"del"') || lower.includes("'del'")) {
      if (this.getValidValue(keys[0]) === String(args[0])) {
        this.store.delete(keys[0]);
        return 1;
      }
      return 0;
    }
    if (
      (lower.includes('"pexpire"') || lower.includes("'pexpire'")) &&
      (lower.includes('"get"') || lower.includes("'get'"))
    ) {
      if (this.getValidValue(keys[0]) === String(args[0])) {
        return this.pexpire(keys[0], Number(args[1]));
      }
      return 0;
    }
    if (lower.includes('"incr"') || lower.includes("'incr'")) {
      const count = await this.incr(keys[0]);
      if (count === 1) {
        await this.pexpire(keys[0], Number(args[0]));
      }
      return count;
    }
    return null;
  }

  clear(): void {
    this.store.clear();
  }

  keys(): string[] {
    this.cleanupAllExpired();
    return Array.from(this.store.keys());
  }

  size(): number {
    this.cleanupAllExpired();
    return this.store.size;
  }

  private getValidValue(key: string): string | null {
    this.cleanupExpiredKey(key);
    return this.store.get(key)?.value ?? null;
  }

  private cleanupExpiredKey(key: string): void {
    const entry = this.store.get(key);
    if (entry?.expiry && Date.now() > entry.expiry) {
      this.store.delete(key);
    }
  }

  private cleanupAllExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiry && now > entry.expiry) {
        this.store.delete(key);
      }
    }
  }
}

let mockRedisInstance: MockRedis | null = null;

export function getMockRedis(): MockRedis {
  if (!mockRedisInstance) {
    mockRedisInstance = new MockRedis();
  }
  return mockRedisInstance;
}

export function resetMockRedis(): void {
  if (mockRedisInstance) {
    mockRedisInstance.clear();
  }
}

export default getMockRedis();
