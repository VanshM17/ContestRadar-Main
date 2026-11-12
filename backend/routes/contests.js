// GET /api/contests
// Aggregates upcoming contests from all platform adapters, with per-platform
// error isolation so one dead feed never breaks the whole page.
import { Router } from 'express';
import { Cache } from '../cache/memory-cache.js';
import { ADAPTERS, PLATFORMS, getAdapter } from '../adapters/registry.js';

const router = Router();

// Normalized contest shape:
// { site, name, start_time, end_time, url, is_live }
router.get('/', async (req, res, next) => {
  try {
    const platforms = PLATFORMS.filter(p => {
      // Skip stub platforms that have no real data source yet.
      return p !== 'HackerRank' && p !== 'HackerEarth' && p !== 'GeeksforGeeks' && p !== 'Codeforces Gym';
    });

    const results = await Promise.allSettled(
      platforms.map(async (site) => {
        const adapter = getAdapter(site);
        const contests = await Cache.get(
          `contests:${site}`,
          () => adapter.fetchContests(),
          900 // 15 min TTL
        );
        return contests;
      })
    );

    const all = [];
    let degraded = [];
    results.forEach((result, i) => {
      const site = platforms[i];
      if (result.status === 'fulfilled') {
        all.push(...result.value);
      } else {
        degraded.push(site);
        console.warn(`[contests] ${site} feed failed: ${result.reason?.message || result.reason}`);
      }
    });

    all.sort((a, b) => a.start_time - b.start_time);

    res.json({
      ok: true,
      count: all.length,
      degraded,
      contests: all,
      cachedAt: new Date().toISOString()
    });
  } catch (err) {
    next(err);
  }
});

export default router;
