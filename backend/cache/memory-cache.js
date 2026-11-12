// In-memory TTL cache for third-party platform responses.
// Keeps the browser from hammering unofficial APIs on every load,
// and lets us serve stale data gracefully when a platform is down.
import NodeCache from 'node-cache';

const cache = new NodeCache({ stdTTL: 900, checkperiod: 120 }); // 15 min default TTL

export const Cache = {
  // Get a cached value, or run `fetch` and store the result.
  async get(key, fetch, ttl = 900) {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    let data;
    try {
      data = await fetch();
    } catch (err) {
      // On fetch failure, serve stale cache if we have it (graceful degradation).
      const stale = cache.get(key);
      if (stale !== undefined) return stale;
      throw err;
    }

    cache.set(key, data, ttl);
    return data;
  },

  // Invalidate a single key (e.g. after a manual refresh).
  del(key) {
    cache.del(key);
  },

  // Flush everything (useful in tests).
  flush() {
    cache.flushAll();
  },

  stats() {
    return cache.getStats();
  }
};
