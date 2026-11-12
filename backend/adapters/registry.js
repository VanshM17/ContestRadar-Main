// Adapter registry — one instance per platform. Add a new platform here,
// then add its route in routes/ratings.js and routes/contests.js.
import { CodeforcesAdapter } from './codeforces.js';
import { LeetCodeAdapter } from './leetcode.js';
import { CodeChefAdapter } from './codechef.js';
import { AtCoderAdapter } from './atcoder.js';
import { HackerRankAdapter } from './stubs.js';
import { HackerEarthAdapter } from './stubs.js';
import { GeeksforGeeksAdapter } from './stubs.js';
import { CodeforcesGymAdapter } from './stubs.js';

export const ADAPTERS = {
  Codeforces: new CodeforcesAdapter(),
  LeetCode: new LeetCodeAdapter(),
  CodeChef: new CodeChefAdapter('https://contest-radar-codechef.vanshm17112005.workers.dev'),
  AtCoder: new AtCoderAdapter(),
  'HackerRank': new HackerRankAdapter(),
  'HackerEarth': new HackerEarthAdapter(),
  'GeeksforGeeks': new GeeksforGeeksAdapter(),
  'Codeforces Gym': new CodeforcesGymAdapter()
};

export const PLATFORMS = Object.keys(ADAPTERS);

export function getAdapter(site) {
  const a = ADAPTERS[site];
  if (!a) throw new Error(`Unknown platform: ${site}`);
  return a;
}
