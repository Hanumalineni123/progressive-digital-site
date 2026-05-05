import postgres from 'postgres';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Connection — postgres() is lazy, connects on first query
// Connection string lives in env only; never hardcode credentials
// ---------------------------------------------------------------------------
const sql = postgres(process.env.DATABASE_URL, {
  max: 10,                    // max pool connections
  idle_timeout: 30,           // drop idle connections after 30s
  connect_timeout: 10,        // fail fast if DB is unreachable
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
});

// ---------------------------------------------------------------------------
// saveLead
// Inserts a new lead record. If the same idempotency key arrives twice
// (e.g. user retried after a network blip), returns the existing record
// instead of creating a duplicate.
// ---------------------------------------------------------------------------
export async function saveLead({ name, email, organization, service, message, ipHash, idempotencyKey }) {

  // Idempotency check — look up by key before inserting
  if (idempotencyKey) {
    const existing = await sql`
      SELECT * FROM leads
      WHERE idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    if (existing.length > 0) {
      logger.info({ leadId: existing[0].id }, 'Duplicate submission — returning existing lead');
      return existing[0];
    }
  }

  const [lead] = await sql`
    INSERT INTO leads (name, email, organization, service, message, ip_hash, idempotency_key)
    VALUES (${name}, ${email}, ${organization}, ${service}, ${message}, ${ipHash}, ${idempotencyKey})
    RETURNING *
  `;

  return lead;
}

// ---------------------------------------------------------------------------
// getLeads — for internal dashboard use; never expose this publicly
// ---------------------------------------------------------------------------
export async function getLeads({ status, limit = 50, offset = 0 } = {}) {
  if (status) {
    return sql`
      SELECT id, name, email, organization, service, status, created_at
      FROM leads
      WHERE status = ${status}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }
  return sql`
    SELECT id, name, email, organization, service, status, created_at
    FROM leads
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

// ---------------------------------------------------------------------------
// updateLeadStatus — move a lead through the pipeline
// ---------------------------------------------------------------------------
export async function updateLeadStatus(id, status) {
  const VALID_STATUSES = ['new', 'contacted', 'converted', 'closed'];
  if (!VALID_STATUSES.includes(status)) throw new Error('Invalid status: ' + status);

  const [lead] = await sql`
    UPDATE leads SET status = ${status}, updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  return lead;
}

export { sql };
