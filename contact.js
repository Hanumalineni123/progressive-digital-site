import express from 'express';
import { body, validationResult } from 'express-validator';
import { rateLimit } from 'express-rate-limit';
import { saveLead } from '../lib/db.js';
import { queueLeadJobs } from '../jobs/leadQueue.js';
import { logger } from '../lib/logger.js';

export const router = express.Router();

// ---------------------------------------------------------------------------
// Rate limiter — 3 submissions per IP per hour
// Keyed on IP so a single bad actor can't flood submissions
// ---------------------------------------------------------------------------
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions from this IP. Please try again in an hour.' },
  keyGenerator: (req) => req.ip,
});

// ---------------------------------------------------------------------------
// Validation rules — always validate server-side regardless of client checks
// ---------------------------------------------------------------------------
const ALLOWED_SERVICES = [
  'agile-transformation',
  'pmo-strategy',
  'pm-certification',
  'lean-vsm',
  'executive-coaching',
  'tailored-workshop',
  'other',
];

const contactValidators = [
  body('name')
    .trim()
    .notEmpty().withMessage('Name is required.')
    .isLength({ max: 100 }).withMessage('Name must be 100 characters or fewer.'),

  body('email')
    .trim()
    .notEmpty().withMessage('Email is required.')
    .isEmail().withMessage('A valid email address is required.')
    .normalizeEmail()
    .isLength({ max: 254 }).withMessage('Email is too long.'),

  body('organization')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 200 }).withMessage('Organization name must be 200 characters or fewer.'),

  body('service')
    .optional({ nullable: true, checkFalsy: true })
    .isIn(ALLOWED_SERVICES).withMessage('Invalid service selection.'),

  body('message')
    .trim()
    .notEmpty().withMessage('Message is required.')
    .isLength({ max: 2000 }).withMessage('Message must be 2,000 characters or fewer.'),
];

// ---------------------------------------------------------------------------
// POST /api/contact
// ---------------------------------------------------------------------------
router.post(
  '/',
  contactLimiter,
  contactValidators,
  async (req, res) => {
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();
    const idempotencyKey = req.headers['x-idempotency-key'];
    const log = logger.child({ requestId, route: 'POST /api/contact' });

    // Validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      log.warn({ errors: errors.array() }, 'Validation failed');
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { name, email, organization, service, message } = req.body;

    try {
      // Persist lead — saveLead handles idempotency deduplication by idempotency key
      const lead = await saveLead({
        name,
        email,
        organization: organization || null,
        service: service || null,
        message,
        ipHash: hashIp(req.ip),   // store hashed IP only — never raw (CCPA/GDPR)
        idempotencyKey: idempotencyKey || null,
      });

      log.info({ leadId: lead.id, email: maskEmail(email) }, 'Lead saved');

      // Queue async jobs — do NOT await; return 200 immediately
      // Jobs: send confirmation email to user, notify team, push to CRM
      queueLeadJobs(lead).catch(err =>
        log.error({ err, leadId: lead.id }, 'Failed to queue lead jobs')
      );

      return res.status(200).json({ status: 'ok' });

    } catch (err) {
      // Log full error internally; return a safe generic message to the client
      log.error({ err }, 'Failed to save lead');
      return res.status(500).json({ error: 'Something went wrong. Please try again or email us directly.' });
    }
  }
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Hash an IP address with SHA-256 for rate-limit deduplication.
 * We store the hash, never the raw IP, to comply with CCPA/GDPR.
 */
async function hashIp(ip) {
  if (!ip) return null;
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + process.env.IP_HASH_SALT);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Mask email for safe logging — never log full email addresses */
function maskEmail(email) {
  const [user, domain] = email.split('@');
  return user.slice(0, 2) + '***@' + domain;
}
