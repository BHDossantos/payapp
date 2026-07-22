import { HttpError } from '../lib/http.js';
import { requireAmountCents, optionalString, toEuros } from '../lib/validate.js';
import { resolveUser, walletFor } from './accounts.js';
import { createRequestRecord } from './requests.js';
import { notify } from './notifications.js';

const FREQUENCIES = new Set(['once', 'weekly', 'monthly']);

// Advances a date by one period. Monthly preserves the day-of-month, clamping to
// the target month's length (e.g. Jan 31 -> Feb 28). All math is in UTC.
function advance(dateISO, frequency) {
  const d = new Date(dateISO);
  if (frequency === 'weekly') {
    return new Date(d.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  }
  // monthly
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth() + 1, 1,
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(),
  ));
  const daysInTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTarget));
  return target.toISOString();
}

export function publicSchedule(store, s) {
  const requestor = store.get('users', s.requestorId);
  const recipient = store.get('users', s.recipientId);
  return {
    schedule_id: s.id,
    requestor_id: s.requestorId,
    recipient_id: s.recipientId,
    requestor_name: requestor ? `${requestor.firstName} ${requestor.lastName}` : 'Unknown',
    recipient_name: recipient ? `${recipient.firstName} ${recipient.lastName}` : 'Unknown',
    amount: toEuros(s.amountCents),
    currency: s.currency,
    reason: s.reason,
    frequency: s.frequency,
    status: s.status,
    next_run_at: s.nextRunAt,
    last_run_at: s.lastRunAt,
    runs_count: s.runsCount,
    end_at: s.endAt,
    created_at: s.createdAt,
  };
}

// The requestor (e.g. a landlord) sets up recurring collection from the payer.
export function createSchedule(store, requestorId, body) {
  const amountCents = requireAmountCents(body);
  const reason = optionalString(body, 'reason', { max: 140 });
  const frequency = (body.frequency || 'monthly').toLowerCase();
  if (!FREQUENCIES.has(frequency)) {
    throw new HttpError(400, `frequency must be one of: ${[...FREQUENCIES].join(', ')}`);
  }

  const recipient = resolveUser(store, {
    username: body.username, email: body.email, phone: body.phone,
  });
  if (!recipient) throw new HttpError(404, 'No EuroFlow user matches that handle');
  if (recipient.id === requestorId) throw new HttpError(400, 'Cannot schedule a request to yourself');

  // First run defaults to now (so it fires on the next processing tick) unless a
  // future start_date is given.
  let nextRunAt = new Date().toISOString();
  if (body.start_date) {
    const t = Date.parse(body.start_date);
    if (Number.isNaN(t)) throw new HttpError(400, 'start_date must be a valid date');
    nextRunAt = new Date(t).toISOString();
  }
  let endAt = null;
  if (body.end_date) {
    const t = Date.parse(body.end_date);
    if (Number.isNaN(t)) throw new HttpError(400, 'end_date must be a valid date');
    endAt = new Date(t).toISOString();
  }

  const wallet = walletFor(store, requestorId);
  const schedule = store.insert('scheduledRequests', {
    requestorId,
    recipientId: recipient.id,
    amountCents,
    currency: wallet.currency,
    reason,
    frequency,
    status: 'active',
    nextRunAt,
    lastRunAt: null,
    runsCount: 0,
    endAt,
    createdAt: new Date().toISOString(),
  });
  return publicSchedule(store, schedule);
}

export function listSchedules(store, userId, box = 'outgoing') {
  const field = box === 'incoming' ? 'recipientId' : 'requestorId';
  return store
    .filter('scheduledRequests', (s) => s[field] === userId)
    .sort((a, b) => (b.nextRunAt || '').localeCompare(a.nextRunAt || ''))
    .map((s) => publicSchedule(store, s));
}

function ownedSchedule(store, userId, id) {
  const s = store.get('scheduledRequests', id);
  if (!s) throw new HttpError(404, 'Schedule not found');
  if (s.requestorId !== userId) throw new HttpError(403, 'Only the schedule owner can manage it');
  return s;
}

export function getSchedule(store, userId, id) {
  const s = store.get('scheduledRequests', id);
  if (!s) throw new HttpError(404, 'Schedule not found');
  if (s.requestorId !== userId && s.recipientId !== userId) {
    throw new HttpError(403, 'Not your schedule');
  }
  return publicSchedule(store, s);
}

export function setStatus(store, userId, id, action) {
  const s = ownedSchedule(store, userId, id);
  const map = { pause: 'paused', resume: 'active', cancel: 'cancelled' };
  const status = map[action];
  if (!status) throw new HttpError(400, `Unknown action "${action}"`);
  if (s.status === 'cancelled') throw new HttpError(409, 'Schedule is already cancelled');
  store.update('scheduledRequests', id, { status });
  return publicSchedule(store, store.get('scheduledRequests', id));
}

// Generates payment requests for every active schedule whose next_run_at has
// passed. Idempotent per due date: each run advances next_run_at, so calling it
// repeatedly will not double-charge. Returns a summary for cron/admin callers.
export function runDue(store, now = new Date()) {
  const nowMs = now.getTime();
  const due = store.filter(
    'scheduledRequests',
    (s) => s.status === 'active' && Date.parse(s.nextRunAt) <= nowMs,
  );

  let ran = 0;
  for (const s of due) {
    // A schedule could be overdue by multiple periods (e.g. server was down).
    // Catch up by emitting one request per missed occurrence, capped to avoid
    // runaway loops on a misconfigured far-past start date.
    let guard = 0;
    while (s.status === 'active' && Date.parse(s.nextRunAt) <= nowMs && guard < 60) {
      createRequestRecord(store, {
        requestorId: s.requestorId,
        recipientId: s.recipientId,
        amountCents: s.amountCents,
        currency: s.currency,
        reason: s.reason || 'Scheduled request',
        scheduleId: s.id,
      });
      ran += 1;
      guard += 1;

      const patch = { lastRunAt: new Date().toISOString(), runsCount: s.runsCount + guard };
      if (s.frequency === 'once') {
        patch.status = 'completed';
      } else {
        const next = advance(s.nextRunAt, s.frequency);
        if (s.endAt && Date.parse(next) > Date.parse(s.endAt)) {
          patch.status = 'completed';
        }
        patch.nextRunAt = next;
        s.nextRunAt = next; // keep loop condition in sync
      }
      s.status = patch.status || s.status;
      store.update('scheduledRequests', s.id, patch);
    }
  }
  return { ran, due_schedules: due.length };
}
