// GET /api/ratings/:platform/:handle
// GET /api/ratings (batch: ?platform=Codeforces&handle=X&platform=LeetCode&handle=Y)
import { Router } from 'express';
import { Cache } from '../cache/memory-cache.js';
import { getAdapter, ADAPTERS } from '../adapters/registry.js';

const router = Router();

router.get('/:platform/:handle', async (req, res, next) => {
  try {
    const { platform, handle } = req.params;
    const adapter = getAdapter(platform);
    const data = await Cache.get(
      `rating:${platform}:${handle.toLowerCase()}`,
      () => adapter.fetchRating(handle),
      900
    );
    res.json({ ok: true, platform, handle, ...data });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const platforms = req.query.platform;
    const handles = req.query.handle;
    const plist = Array.isArray(platforms) ? platforms : platforms ? [platforms] : [];
    const hlist = Array.isArray(handles) ? handles : handles ? [handles] : '';

    if (plist.length !== hlist.length) {
      return res.status(400).json({ ok: false, error: 'platform and handle arrays must match' });
    }

    const results = await Promise.allSettled(
      plist.map((p, i) => {
        const adapter = getAdapter(p);
        return Cache.get(
          `rating:${p}:${hlist[i].toLowerCase()}`,
          () => adapter.fetchRating(hlist[i]),
          900
        );
      })
    );

    const out = {};
    plist.forEach((p, i) => {
      const r = results[i];
      out[p] = r.status === 'fulfilled'
        ? { ok: true, handle: hlist[i], ...r.value }
        : { ok: false, error: r.reason?.message || String(r.reason) };
    });

    res.json({ ok: true, ratings: out });
  } catch (err) {
    next(err);
  }
});

export default router;
