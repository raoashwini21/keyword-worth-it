// Structured server-side logging. Full error detail (stack traces, upstream
// bodies) goes here — never into a client response. Each request gets a short
// ref id that is also shown to the user on 5xx errors, so a user report can be
// matched to the log line.

import crypto from 'node:crypto';

export function newRequestId() {
  return crypto.randomBytes(4).toString('hex');
}

export function createLogger(reqId) {
  const emit = (level, event, fields = {}) => {
    const out = { level, event, reqId, ...fields };
    if (fields.err instanceof Error) {
      out.err = { name: fields.err.name, message: fields.err.message, code: fields.err.code, stack: fields.err.stack };
    }
    const line = JSON.stringify(out);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}
