import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // In production, output newline-delimited JSON for log aggregators (Logtail, Datadog)
  // In development, pretty-print for readability
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
  base: {
    service: 'progressive-digital-api',
    env: process.env.NODE_ENV,
  },
  // Redact sensitive fields from every log line automatically
  redact: {
    paths: ['req.headers.authorization', 'body.email', 'body.message'],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
