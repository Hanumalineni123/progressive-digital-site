import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { router as contactRouter } from './routes/contact.js';
import { logger } from './lib/logger.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ---------------------------------------------------------------------------
// Security headers — helmet sets Content-Security-Policy, HSTS, and more
// ---------------------------------------------------------------------------
app.use(helmet());

// ---------------------------------------------------------------------------
// CORS — locked to your domain only; never use wildcard on a write endpoint
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://progressivedigital.com')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. server-to-server, health checks)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      logger.warn({ origin }, 'CORS rejected request from disallowed origin');
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Idempotency-Key', 'X-Request-ID'],
}));

// ---------------------------------------------------------------------------
// Body parsing — cap at 16kb to prevent large payload attacks
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '16kb' }));

// ---------------------------------------------------------------------------
// Request logging — log every request with method, path, status, duration
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: Date.now() - start + 'ms',
      ip: req.ip,
    }, 'Request');
  });
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/contact', contactRouter);

// ---------------------------------------------------------------------------
// 404 handler — return JSON, not HTML, for API routes
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Global error handler — never leak stack traces to the client
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  logger.error({ err, path: req.path }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV }, 'Server started');
});

export default app;
