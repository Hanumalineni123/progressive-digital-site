/**
 * Stripe Webhook Handler — POST /api/webhooks/stripe
 *
 * WHY WEBHOOKS MATTER:
 * Never fulfill an enrollment based on the success_url redirect alone.
 * The redirect can be faked or interrupted. Webhooks come directly from
 * Stripe's servers and are cryptographically signed — this is the only
 * source of truth for whether payment actually succeeded.
 *
 * SETUP:
 *   1. In Stripe Dashboard → Webhooks → Add endpoint
 *   2. URL: https://yourapi.com/api/webhooks/stripe
 *   3. Events to listen for:
 *        - checkout.session.completed
 *        - invoice.payment_succeeded      (subscription renewals)
 *        - invoice.payment_failed         (failed subscription payment)
 *        - customer.subscription.deleted  (cancellation)
 *   4. Copy the signing secret into STRIPE_WEBHOOK_SECRET env var
 */

import express from 'express';
import Stripe from 'stripe';
import { saveEnrollment, updateEnrollmentStatus } from '../lib/db.js';
import { sendEnrollmentConfirmation } from '../jobs/emailQueue.js';
import { logger } from '../lib/logger.js';

export const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-04-10',
});

// ---------------------------------------------------------------------------
// CRITICAL: Stripe requires the RAW request body to verify the signature.
// This route must be registered BEFORE express.json() in server.js.
// In server.js, add this line before app.use(express.json()):
//   app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const log = logger.child({ route: 'POST /api/webhooks/stripe' });

  // Verify the event came from Stripe, not a random POST
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,                              // raw Buffer — NOT parsed JSON
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    log.warn({ err: err.message }, 'Webhook signature verification failed');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  log.info({ type: event.type, id: event.id }, 'Webhook received');

  // Acknowledge receipt immediately — Stripe expects a 200 within 30 seconds
  // Handle the event asynchronously so we don't time out on slow DB writes
  res.status(200).json({ received: true });

  // Process event — errors here don't affect the 200 we already sent
  try {
    await handleEvent(event, log);
  } catch (err) {
    // Log but don't rethrow — Stripe will retry if we hadn't already 200'd
    log.error({ err, eventType: event.type, eventId: event.id }, 'Webhook handler error');
  }
});

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------
async function handleEvent(event, log) {
  switch (event.type) {

    // ── One-time payment OR first installment paid ──────────────────────────
    case 'checkout.session.completed': {
      const session = event.data.object;

      // For subscriptions, wait for invoice.payment_succeeded to confirm funds
      // For one-time payments, session.payment_status === 'paid' means done
      if (session.payment_status !== 'paid') {
        log.info({ sessionId: session.id }, 'Session complete but payment pending — waiting for invoice event');
        return;
      }

      await fulfillEnrollment({
        stripeSessionId: session.id,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription || null,
        courseId: session.metadata.courseId,
        mode: session.metadata.mode,
        customerEmail: session.customer_details?.email,
        customerName: session.customer_details?.name,
        amountTotal: session.amount_total,
        currency: session.currency,
        log,
      });
      break;
    }

    // ── Subscription renewal payment succeeded ──────────────────────────────
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      if (invoice.billing_reason === 'subscription_create') {
        // First invoice already handled by checkout.session.completed
        return;
      }
      log.info({ invoiceId: invoice.id, subscriptionId: invoice.subscription }, 'Subscription renewal paid');
      await updateEnrollmentStatus(invoice.subscription, 'active');
      break;
    }

    // ── Subscription payment failed ─────────────────────────────────────────
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      log.warn({ invoiceId: invoice.id, subscriptionId: invoice.subscription }, 'Subscription payment failed');
      await updateEnrollmentStatus(invoice.subscription, 'past_due');
      // TODO: send dunning email to customer
      break;
    }

    // ── Subscription cancelled ──────────────────────────────────────────────
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      log.info({ subscriptionId: sub.id }, 'Subscription cancelled');
      await updateEnrollmentStatus(sub.id, 'cancelled');
      break;
    }

    default:
      log.info({ type: event.type }, 'Unhandled webhook event type — ignoring');
  }
}

// ---------------------------------------------------------------------------
// fulfillEnrollment — write to DB and send confirmation email
// ---------------------------------------------------------------------------
async function fulfillEnrollment({ stripeSessionId, stripeCustomerId, stripeSubscriptionId, courseId, mode, customerEmail, customerName, amountTotal, currency, log }) {
  const enrollment = await saveEnrollment({
    stripeSessionId,
    stripeCustomerId,
    stripeSubscriptionId,
    courseId,
    paymentMode: mode,
    customerEmail,
    customerName,
    amountPaid: amountTotal,
    currency,
    status: 'active',
  });

  log.info({ enrollmentId: enrollment.id, courseId, customerEmail }, 'Enrollment fulfilled');

  // Send confirmation email async — failure here shouldn't re-trigger the webhook
  sendEnrollmentConfirmation(enrollment).catch(err =>
    log.error({ err, enrollmentId: enrollment.id }, 'Failed to send enrollment confirmation email')
  );
}
