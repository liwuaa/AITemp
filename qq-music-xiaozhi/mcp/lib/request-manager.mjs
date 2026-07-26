/**
 * Concurrency limiter + singleflight for identical in-flight keys.
 */
export class RequestManager {
  /**
   * @param {{ concurrency?: number }} [options]
   */
  constructor(options = {}) {
    this.concurrency = Math.max(1, Number(options.concurrency) || 4);
    this.active = 0;
    /** @type {Array<() => void>} */
    this.waiters = [];
    /** @type {Map<string, Promise<unknown>>} */
    this.inflight = new Map();
  }

  async acquire() {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async singleflight(key, fn) {
    const existing = this.inflight.get(key);
    if (existing) return /** @type {Promise<T>} */ (existing);

    const promise = (async () => {
      await this.acquire();
      try {
        return await fn();
      } finally {
        this.release();
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  stats() {
    return {
      concurrency: this.concurrency,
      active: this.active,
      queued: this.waiters.length,
      inflight: this.inflight.size,
    };
  }
}
