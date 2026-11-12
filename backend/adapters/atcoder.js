// AtCoder adapter — Contest Hive mirror for upcoming, Jina reader for history JSON.
import PlatformAdapter from './base.js';

export class AtCoderAdapter extends PlatformAdapter {
  constructor() { super('AtCoder'); }

  async _get(url, timeoutMs = 20000) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`AtCoder upstream: HTTP ${res.status}`);
    return res.json();
  }

  async _getText(url, timeoutMs = 25000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } finally { clearTimeout(t); }
  }

  async fetchContests() {
    const data = await this._get('https://contest-hive.vercel.app/api/atcoder');
    if (!data || !data.ok) return [];
    return data.data
      .filter(c => /Beginner Contest|Regular Contest|Grand Contest/i.test(c.title))
      .map(c => this.normalize({
        name: c.title,
        start_time: new Date(c.startTime).getTime(),
        end_time: new Date(c.endTime).getTime(),
        url: c.url,
        is_live: false
      }));
  }

  async fetchRating(handle) {
    const url = `https://atcoder.jp/users/${encodeURIComponent(handle)}/history/json`;

    // 1) Direct fetch (works if AtCoder ever opens CORS).
    try {
      const d = await this._get(url);
      if (Array.isArray(d) && d.length) return this._norm(d);
    } catch { /* browsers block this (no CORS) — fall through */ }

    // 2) Jina reader mirror (CORS-open).
    let txt;
    try {
      txt = await this._getText(`https://r.jina.ai/${url}`);
    } catch (e) {
      if (/429|rate/i.test(e.message || '')) throw new Error('AtCoder mirror is rate-limited - try again in a minute');
      throw new Error('AtCoder history unreachable');
    }
    const a = txt.indexOf('['), b = txt.lastIndexOf(']');
    if (a < 0 || b <= a) throw new Error('No AtCoder history');
    let d;
    try { d = JSON.parse(txt.slice(a, b + 1)); }
    catch { throw new Error('No AtCoder history'); }
    if (!Array.isArray(d) || !d.length) throw new Error('No AtCoder history');
    return this._norm(d);
  }

  _norm(d) {
    const points = d
      .filter(x => x.IsRated !== false)
      .map(x => ({
        t: new Date(x.EndTime).getTime(),
        rating: x.NewRating,
        delta: x.NewRating - x.OldRating,
        rank: x.Place || null,
        name: x.ContestName || 'AtCoder contest',
        extra: ''
      }));
    if (!points.length) throw new Error('No rated AtCoder contests');
    return { points, current: points[points.length - 1].rating, meta: {} };
  }
}
