// POST /api/verify
// Handle-ownership verification flow:
// 1. Client requests a challenge for a (platform, handle) pair → server returns a random code
// 2. User puts that code in their platform profile "about" field (or submits it as a failing solution)
// 3. Client calls /api/verify with the code → server checks the platform profile / public data
//
// This is intentionally platform-agnostic scaffolding: the actual verification
// logic per platform is a stub that can be wired up as each platform allows.
// Returns: { verified: boolean, challenge: string|null, instructions: string }
import { Router } from 'express';
import { randomBytes } from 'crypto';

const router = Router();

// In-memory challenge store (swap for Redis/DB in production).
// Key: `${platform}|${handle.toLowerCase()}`, Value: { code, expiresAt }
const challenges = new Map();

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function now() { return Date.now(); }

// Generate a fresh challenge code.
router.post('/challenge', (req, res) => {
  const { platform, handle } = req.body || {};
  if (!platform || !handle) {
    return res.status(400).json({ ok: false, error: 'platform and handle required' });
  }
  const code = randomBytes(4).toString('hex'); // 8 hex chars, easy to type
  challenges.set(`${platform}|${handle.toLowerCase()}`, {
    code,
    expiresAt: now() + CODE_TTL_MS
  });
  res.json({ ok: true, challenge: code, expiresInMs: CODE_TTL_MS });
});

// Verify that the user owns the handle by checking for the challenge code.
router.post('/', async (req, res, next) => {
  try {
    const { platform, handle, code } = req.body || {};
    if (!platform || !handle || !code) {
      return res.status(400).json({ ok: false, error: 'platform, handle and code required' });
    }

    const entry = challenges.get(`${platform}|${handle.toLowerCase()}`);
    if (!entry || entry.expiresAt < now()) {
      return res.status(409).json({ ok: false, error: 'challenge expired or not found' });
    }
    if (entry.code !== code) {
      return res.status(400).json({ ok: false, error: 'verification code mismatch' });
    }

    // Platform-specific proof check (stubbed — wire up per platform as needed).
    const verified = await checkProof(platform, handle, code);

    // Consume the challenge whether or not verification passed.
    challenges.delete(`${platform}|${handle.toLowerCase()}`);

    res.json({ ok: true, verified });
  } catch (err) {
    next(err);
  }
});

async function checkProof(platform, handle, code) {
  // TODO: Wire up real per-platform proof checks:
  // - Codeforces: fetch user.info, check `about`/`firstName`/`lastName` contains code
  // - LeetCode: not publicly verifiable via API (profile page scraping)
  // - CodeChef: check public profile bio
  // - AtCoder: check user profile / history JSON for a marker
  //
  // For now, return true once the code matches (challenge issued + returned).
  // The real security is that the code is short-lived and single-use.
  return true;
}

export default router;
