// Codeforces adapter — official, stable API.
//   contest.list  -> upcoming contests
//   user.info     -> current rating + title
//   user.rating   -> full rating history
import PlatformAdapter from './base.js';

const CF_BASE = 'https://codeforces.com/api';

export class CodeforcesAdapter extends PlatformAdapter {
  constructor() { super('Codeforces'); }

  async _get(path, timeoutMs = 15000) {
    const res = await fetch(`${CF_BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Codeforces ${path}: HTTP ${res.status}`);
    return res.json();
  }

  async fetchContests() {
    const data = await this._get('/contest.list');
    if (data.status !== 'OK') return [];
    const now = Date.now();
    return data.result
      .filter(c => c.phase === 'BEFORE' || c.phase === 'CODING')
      .map(c => this.normalize({
        name: c.name,
        start_time: c.startTimeSeconds * 1000,
        end_time: (c.startTimeSeconds + (c.durationSeconds || 0)) * 1000,
        url: `https://codeforces.com/contest/${c.id}`,
        is_live: c.phase === 'CODING'
      }));
  }

  async fetchRating(handle) {
    const [info, history] = await Promise.all([
      this._get(`/user.info?handles=${encodeURIComponent(handle)}`),
      this._get(`/user.rating?handle=${encodeURIComponent(handle)}`)
    ]);
    if (info.status !== 'OK' || !info.result.length) throw new Error('Codeforces user not found');
    if (history.status !== 'OK') throw new Error('No Codeforces rating history');

    const user = info.result[0];
    const points = history.result.map(r => ({
      t: r.ratingUpdateTimeSeconds * 1000,
      rating: r.newRating,
      delta: r.newRating - r.oldRating,
      rank: r.rank,
      name: r.contestName,
      extra: ''
    }));

    return {
      current: user.rating ?? 0,
      points,
      meta: {
        handle: user.handle,
        maxRating: user.maxRating,
        title: this.title(user.rating)
      }
    };
  }

  title(r) {
    if (r == null) return 'Unrated';
    if (r < 1200) return 'Newbie';
    if (r < 1400) return 'Pupil';
    if (r < 1600) return 'Specialist';
    if (r < 1900) return 'Expert';
    if (r < 2100) return 'Candidate Master';
    if (r < 2300) return 'Master';
    if (r < 2400) return 'International Master';
    if (r < 2600) return 'Grandmaster';
    if (r < 3000) return 'Intl. Grandmaster';
    return 'Legendary Grandmaster';
  }
}
