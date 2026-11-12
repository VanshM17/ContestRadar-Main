// ContestRadar backend server
// Normalized contest + rating API with per-platform adapters, TTL caching,
// rate limiting, and graceful degradation when third-party feeds are down.
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { Cache } from './cache/memory-cache.js';

import contestsRoute from './routes/contests.js';
import ratingsRoute from './routes/ratings.js';
import verifyRoute from './routes/verify.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ---------- Security / middleware ----------
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '64kb' }));

// Rate limiting: 60 requests/minute per IP for API routes.
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests, please slow down.' }
}));

// ---------- Health ----------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'contestradar-api', time: new Date().toISOString() });
});

// ---------- API routes ----------
app.use('/api/contests', contestsRoute);
app.use('/api/ratings', ratingsRoute);
app.use('/api/verify', verifyRoute);

// ---------- 404 ----------
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

// ---------- Error handler ----------
app.use((err, _req, res, _next) => {
  console.error('[api error]', err);
  res.status(500).json({
    ok: false,
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

app.listen(PORT, () => {
  console.log(`ContestRadar API listening on :${PORT}`);
});

export { Cache };
