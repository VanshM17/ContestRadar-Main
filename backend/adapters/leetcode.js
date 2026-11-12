// LeetCode adapter — alfa LeetCode API (community, no official API).
//   /{username}/contest  -> contest participation + rating
import PlatformAdapter from './base.js';

export class LeetCodeAdapter extends PlatformAdapter {
  constructor() { super('LeetCode'); }

  async _get(url, timeoutMs = 20000) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`LeetCode upstream: HTTP ${res.status}`);
    return res.json();
  }

  async fetchContests() {
    // LeetCode + CodeChef upcoming contests via CompeteAPI mirror (community-run).
    const res = await fetch('https://competeapi.vercel.app/contests/upcoming/', { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('CompeteAPI unreachable');
    const data = await res.json();
    const now = Date.now();
    return data
      .filter(c => c.site === 'leetcode')
      .map(c => this.normalize({
        name: c.title,
        start_time: c.startTime,
        end_time: c.endTime,
        url: c.url,
        is_live: c.startTime <= now && now < c.endTime
      }));
  }

  async fetchRating(username) {
    const d = await this._get(`https://alfa-leetcode-api.onrender.com/${encodeURIComponent(username)}/contest`);
    if (!d || !Array.isArray(d.contestParticipation)) throw new Error('No LeetCode contest data');

    const parts = d.contestParticipation
      .filter(p => p.attended && p.contest && p.contest.startTime)
      .sort((a, b) => a.contest.startTime - b.contest.startTime);

    if (!parts.length) throw new Error('No attended LeetCode contests');

    const points = parts.map((p, i) => ({
      t: p.contest.startTime * 1000,
      rating: Math.round(p.rating),
      delta: i ? Math.round(p.rating - parts[i - 1].rating) : 0,
      rank: p.ranking || null,
      name: p.contest.title || 'LeetCode contest',
      extra: (p.problemsSolved != null) ? `${p.problemsSolved}/${p.totalProblems || '?'} solved` : ''
    }));

    return {
      current: Math.round(d.contestRating || points[points.length - 1].rating),
      points,
      meta: {
        attended: d.contestAttend,
        globalRank: d.contestGlobalRanking,
        topPct: d.contestTopPercentage,
        badge: (d.contestBadges && d.contestBadges.name) || ''
      }
    };
  }
}
