import express from 'express';
import Stripe from 'stripe';
import { rateLimit } from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import { saveEnrollment } from '../lib/db.js';
import { logger } from '../lib/logger.js';

export const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-04-10',
});

// Valid course IDs — must match data-course-id attributes in the HTML
const VALID_COURSE_IDS = [
  'pmp-prep',
  'acp-prep',
  'capm-prep',
  'safe-sp',
  'scrum-master',
  'pm-leadership',
];

// ---------------------------------------------------------------------------
// Rate limiter — 10 checkout attempts per IP per hour
// Prevents someone from hammering the endpoint to probe price IDs
// ---------------------------------------------------------------------------
const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many checkout attempts. Please try again later.' },
});

// ---------------------------------------------------------------------------
// POST /api/checkout
// Creates a Stripe Checkout Session and returns the session ID to the client.
// The client then calls stripe.redirectToCheckout({ sessionId }).
// ---------------------------------------------------------------------------
router.post(
  '/',
  checkoutLimiter,
  [
    body('priceId')
      .trim()
      .notEmpty().withMessage('Price ID is required.')
      .matches(/^price_[a-zA-Z0-9_]+$/).withMessage('Invalid price ID format.'),

    body('courseId')
      .trim()
      .notEmpty().withMessage('Course ID is required.')
      .isIn(VALID_COURSE_IDS).withMessage('Invalid course ID.'),

    body('mode')
      .isIn(['payment', 'subscription']).withMessage('Mode must be payment or subscription.'),
  ],
  async (req, res) => {
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();
    const log = logger.child({ requestId, route: 'POST /api/checkout' });

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      log.warn({ errors: errors.array() }, 'Checkout validation failed');
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { priceId, courseId, mode } = req.body;

    try {
      // Verify the price actually exists in Stripe before creating a session.
      // This prevents a client from swapping in a different price ID.
      const price = await stripe.prices.retrieve(priceId);

      if (!price.active) {
        log.warn({ priceId }, 'Attempted checkout with inactive price');
        return res.status(400).json({ error: 'This course is not currently available.' });
      }

      // Validate mode matches the price type in Stripe
      const expectedType = mode === 'subscription' ? 'recurring' : 'one_time';
      if (price.type !== expectedType) {
        log.warn({ priceId, mode, priceType: price.type }, 'Mode/price type mismatch');
        return res.status(400).json({ error: 'Payment mode does not match the selected price.' });
      }

      const origin = req.headers.origin || process.env.SITE_URL;

      const session = await stripe.checkout.sessions.create({
        mode,                          // 'payment' (one-time) or 'subscription' (installments)
        line_items: [{ price: priceId, quantity: 1 }],

        // Where to send the user after Stripe Checkout
        success_url: `${origin}/enrollment-success?session_id={CHECKOUT_SESSION_ID}&course=${courseId}`,
        cancel_url:  `${origin}/#courses`,

        // Collect billing address for tax purposes
        billing_address_collection: 'auto',

        // Allow promo codes you create in the Stripe dashboard
        allow_promotion_codes: true,

        // Metadata — visible in Stripe dashboard and webhook payloads
        metadata: {
          courseId,
          mode,
          source: 'website',
        },

        // Subscription-specific options
        ...(mode === 'subscription' && {
          subscription_data: {
            metadata: { courseId },
          },
        }),
      });

      log.info({ sessionId: session.id, courseId, mode }, 'Checkout session created');

      return res.status(200).json({ sessionId: session.id });

    } catch (err) {
      // Stripe errors have a `type` field; surface safe messages only
      if (err.type && err.type.startsWith('Stripe')) {
        log.warn({ stripeError: err.message, code: err.code }, 'Stripe error');
        return res.status(400).json({ error: 'Payment setup failed. Please try again.' });
      }
      log.error({ err }, 'Unexpected checkout error');
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }
);
