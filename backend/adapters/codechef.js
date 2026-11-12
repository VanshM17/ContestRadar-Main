// CodeChef adapter — own Cloudflare Worker first (full history), community mirror fallback.
import PlatformAdapter from './base.js';

export class CodeChefAdapter extends PlatformAdapter {
  constructor(proxyUrl) {
    super('CodeChef');
    this.proxyUrl = proxyUrl;
  }

  async _get(url, timeoutMs = 20000) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`CodeChef upstream: HTTP ${res.status}`);
    return res.json();
  }

  async fetchContests() {
    // CodeChef upcoming contests are not reliably exposed by the Worker.
    // Degrade gracefully; upcoming CodeChef contests come via CompeteAPI mirror elsewhere.
    return [];
  }

  async fetchRating(handle) {
    // 1) Own Worker — real per-contest history.
    try {
      const w = await this._get(`${this.proxyUrl}?handle=${encodeURIComponent(handle)}`);
      if (w && Array.isArray(w.points) && w.points.length) {
        const points = w.points
          .map(p => ({
            t: new Date(String(p.date).replace(' ', 'T')).getTime(),
            rating: Math.round(Number(p.rating)),
            delta: 0,
            rank: p.rank != null && p.rank !== '' ? Number(p.rank) : null,
            name: p.name || 'CodeChef contest',
            extra: ''
          }))
          .filter(p => Number.isFinite(p.t) && Number.isFinite(p.rating))
          .sort((a, b) => a.t - b.t);
        for (let i = 1; i < points.length; i++) points[i].delta = points[i].rating - points[i - 1].rating;
        if (points.length) {
          const meta = { worker: true, maxRating: Math.max(...points.map(p => p.rating)) };
          try {
            const d = await this._get(`https://competeapi.vercel.app/user/codechef/${encodeURIComponent(handle)}`);
            if (d) {
              meta.stars = String(d.rating || '').replace(/[^0-9]/g, '');
              meta.globalRank = String(d.global_rank || '').trim();
            }
          } catch { /* enrichment only — graph works without it */ }
          return { points, current: points[points.length - 1].rating, meta };
        }
      }
      throw new Error('empty history');
    } catch (e) {
      if (/HTTP 400|bad handle/i.test(e.message || '')) throw e;
      // Worker down / no history / blocked → fall through to mirror.
    }

    // 2) Fallback: community mirror (current rating only, no graph).
    const d = await this._get(`https://competeapi.vercel.app/user/codechef/${encodeURIComponent(handle)}`);
    if (!d || d.rating_number == null) throw new Error('CodeChef user not found or unrated');
    return {
      points: [],
      current: Number(d.rating_number),
      meta: {
        stars: String(d.rating || '').replace(/[^0-9]/g, ''),
        globalRank: String(d.global_rank || '').trim(),
        maxRating: d.max_rank
      }
    };
  }
}
