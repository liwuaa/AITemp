/**
 * In-memory LRU + TTL request cache.
 * Play URLs stay memory-only (short TTL); metadata may optionally persist.
 */
export class RequestCache {
  /**
   * @param {{ maxEntries?: number, defaultTtlMs?: number }} [options]
   */
  constructor(options = {}) {
    this.maxEntries = Number(options.maxEntries) || 200;
    this.defaultTtlMs = Number(options.defaultTtlMs) || 10 * 60 * 1000;
    /** @type {Map<string, { value: unknown, expiresAt: number }>} */
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /** @param {string} key */
  get(key) {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (Date.now() >= entry.expiresAt) {
      this.map.delete(key);
      this.misses += 1;
      return undefined;
    }
    // LRU refresh
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  /**
   * @param {string} key
   * @param {unknown} value
   * @param {number} [ttlMs]
   */
  set(key, value, ttlMs) {
    const expiresAt = Date.now() + (ttlMs ?? this.defaultTtlMs);
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  /** @param {string} key */
  delete(key) {
    this.map.delete(key);
  }

  /** @param {(key: string) => boolean} predicate */
  deleteWhere(predicate) {
    for (const key of [...this.map.keys()]) {
      if (predicate(key)) this.map.delete(key);
    }
  }

  clear() {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }

  stats() {
    return {
      size: this.map.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      hitRate:
        this.hits + this.misses === 0
          ? 0
          : Number((this.hits / (this.hits + this.misses)).toFixed(3)),
    };
  }
}

export function cacheKey(parts) {
  return parts
    .map((p) =>
      String(p ?? "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
    )
    .join("|");
}
