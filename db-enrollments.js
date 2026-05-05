// ── Add these functions to your existing server/src/lib/db.js ──────────────
// (paste below the existing exports)

// ---------------------------------------------------------------------------
// saveEnrollment — called by the Stripe webhook handler after payment confirmed
// Idempotent: if the same stripe_session_id arrives twice, returns existing row
// ---------------------------------------------------------------------------
export async function saveEnrollment({
  stripeSessionId,
  stripeCustomerId,
  stripeSubscriptionId,
  courseId,
  paymentMode,
  customerEmail,
  customerName,
  amountPaid,
  currency,
  status,
}) {
  // Idempotency: webhook may fire more than once for the same event
  const existing = await sql`
    SELECT * FROM enrollments WHERE stripe_session_id = ${stripeSessionId} LIMIT 1
  `;
  if (existing.length > 0) return existing[0];

  const [enrollment] = await sql`
    INSERT INTO enrollments (
      course_id, stripe_session_id, stripe_customer_id, stripe_subscription_id,
      customer_email, customer_name, payment_mode, amount_paid_cents, currency, status
    ) VALUES (
      ${courseId}, ${stripeSessionId}, ${stripeCustomerId}, ${stripeSubscriptionId || null},
      ${customerEmail}, ${customerName || null}, ${paymentMode}, ${amountPaid || null}, ${currency}, ${status}
    )
    RETURNING *
  `;
  return enrollment;
}

// ---------------------------------------------------------------------------
// updateEnrollmentStatus — called on subscription lifecycle events
// ---------------------------------------------------------------------------
export async function updateEnrollmentStatus(stripeSubscriptionId, status) {
  const VALID = ['active', 'past_due', 'cancelled', 'refunded'];
  if (!VALID.includes(status)) throw new Error('Invalid enrollment status: ' + status);

  await sql`
    UPDATE enrollments
    SET status = ${status}, updated_at = NOW(),
        cancelled_at = ${status === 'cancelled' ? sql`NOW()` : null}
    WHERE stripe_subscription_id = ${stripeSubscriptionId}
  `;
}

// ---------------------------------------------------------------------------
// getCourses — for GET /api/courses endpoint
// ---------------------------------------------------------------------------
export async function getCourses({ category } = {}) {
  if (category) {
    return sql`
      SELECT * FROM courses
      WHERE active = true AND category = ${category}
      ORDER BY sort_order ASC
    `;
  }
  return sql`
    SELECT * FROM courses WHERE active = true ORDER BY sort_order ASC
  `;
}
