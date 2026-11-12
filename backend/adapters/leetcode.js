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
    // LeetCode doesn't expose a public upcoming-contests API reliably.
    // Return [] so the UI degrades gracefully; contests still appear via CompeteAPI mirror
    // in the frontend fallback if needed. Keep this adapter focused on ratings.
    return [];
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
