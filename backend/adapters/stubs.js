// Stub adapters for platforms not yet wired up.
// Each returns [] for contests and throws a clear "not implemented" error for ratings,
// so the UI degrades gracefully instead of breaking.
import PlatformAdapter from './base.js';

export class HackerRankAdapter extends PlatformAdapter {
  constructor() { super('HackerRank'); }
  async fetchContests() { return []; }
  async fetchRating() { throw new Error('HackerRank adapter not yet implemented'); }
}

export class HackerEarthAdapter extends PlatformAdapter {
  constructor() { super('HackerEarth'); }
  async fetchContests() { return []; }
  async fetchRating() { throw new Error('HackerEarth adapter not yet implemented'); }
}

export class GeeksforGeeksAdapter extends PlatformAdapter {
  constructor() { super('GeeksforGeeks'); }
  async fetchContests() { return []; }
  async fetchRating() { throw new Error('GeeksforGeeks adapter not yet implemented'); }
}

export class CodeforcesGymAdapter extends PlatformAdapter {
  constructor() { super('Codeforces Gym'); }
  async fetchContests() { return []; }
  async fetchRating() { throw new Error('Codeforces Gym adapter not yet implemented'); }
}
