import { HttpError } from '../lib/http.js';
import { requireAmountCents, optionalString, toEuros } from '../lib/validate.js';
import { resolveUser, walletFor } from './accounts.js';
import { transfer, publicTransaction } from './payments.js';
import { notify } from './notifications.js';

export function publicRequest(store, reqDoc) {
  const requestor = store.get('users', reqDoc.requestorId);
  const recipient = store.get('users', reqDoc.recipientId);
  return {
    request_id: reqDoc.id,
    requestor_id: reqDoc.requestorId,
    recipient_id: reqDoc.recipientId,
    requestor_name: requestor ? `${requestor.firstName} ${requestor.lastName}` : 'Unknown',
    recipient_name: recipient ? `${recipient.firstName} ${recipient.lastName}` : 'Unknown',
    amount: toEuros(reqDoc.amountCents),
    currency: reqDoc.currency,
    reason: reqDoc.reason,
    status: reqDoc.status,
    created_at: reqDoc.createdAt,
  };
}

// Inserts a pending payment request and notifies the payer. Shared by ad-hoc
// requests and the recurring-schedule runner. `scheduleId` links a request back
// to the schedule that produced it (null for ad-hoc).
export function createRequestRecord(store, { requestorId, recipientId, amountCents, currency, reason, scheduleId = null }) {
  const reqDoc = store.insert('paymentRequests', {
    requestorId,
    recipientId,
    amountCents,
    currency,
    reason,
    scheduleId,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });

  const requestor = store.get('users', requestorId);
  notify(store, recipientId, 'payment_request',
    `${requestor.firstName} requested €${toEuros(amountCents).toFixed(2)}`,
    reason || 'Payment request',
    { request_id: reqDoc.id, amount: toEuros(amountCents), schedule_id: scheduleId });

  return reqDoc;
}

// A asks B for money. `requestorId` is the person who wants to be paid.
export function createRequest(store, requestorId, body) {
  const amountCents = requireAmountCents(body);
  const reason = optionalString(body, 'reason', { max: 140 });
  const recipient = resolveUser(store, {
    username: body.username,
    email: body.email,
    phone: body.phone,
  });
  if (!recipient) throw new HttpError(404, 'No EuroFlow user matches that handle');
  if (recipient.id === requestorId) throw new HttpError(400, 'Cannot request money from yourself');

  const wallet = walletFor(store, requestorId);
  const reqDoc = createRequestRecord(store, {
    requestorId,
    recipientId: recipient.id,
    amountCents,
    currency: wallet.currency,
    reason,
  });
  return publicRequest(store, reqDoc);
}

// Requests where the caller is the one being asked to pay (their inbox), or
// requests they themselves created (outbox), selected by `box`.
export function listRequests(store, userId, box = 'incoming') {
  const field = box === 'outgoing' ? 'requestorId' : 'recipientId';
  return store
    .filter('paymentRequests', (r) => r[field] === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => publicRequest(store, r));
}

// The recipient pays a pending request, settling it with a real transfer.
export function payRequest(store, userId, requestId) {
  const reqDoc = store.get('paymentRequests', requestId);
  if (!reqDoc) throw new HttpError(404, 'Payment request not found');
  if (reqDoc.recipientId !== userId) {
    throw new HttpError(403, 'Only the requested payer can settle this request');
  }
  if (reqDoc.status !== 'pending') {
    throw new HttpError(409, `Request is already ${reqDoc.status}`);
  }
  const tx = transfer(store, {
    senderUserId: userId,
    receiverUserId: reqDoc.requestorId,
    amountCents: reqDoc.amountCents,
    currency: reqDoc.currency,
    reference: reqDoc.reason || 'Payment request',
    type: 'request',
  });
  store.update('paymentRequests', requestId, { status: 'paid' });

  const payer = store.get('users', userId);
  notify(store, reqDoc.requestorId, 'request_paid',
    `${payer.firstName} paid your request`,
    `Your request for €${toEuros(reqDoc.amountCents).toFixed(2)} was paid.`,
    { request_id: requestId, transaction_id: tx.id, amount: toEuros(reqDoc.amountCents) });

  return {
    request: publicRequest(store, store.get('paymentRequests', requestId)),
    transaction: publicTransaction(store, tx, userId),
  };
}

export function declineRequest(store, userId, requestId) {
  const reqDoc = store.get('paymentRequests', requestId);
  if (!reqDoc) throw new HttpError(404, 'Payment request not found');
  if (reqDoc.recipientId !== userId) {
    throw new HttpError(403, 'Only the requested payer can decline this request');
  }
  if (reqDoc.status !== 'pending') {
    throw new HttpError(409, `Request is already ${reqDoc.status}`);
  }
  store.update('paymentRequests', requestId, { status: 'declined' });

  const payer = store.get('users', userId);
  notify(store, reqDoc.requestorId, 'request_declined',
    `${payer.firstName} declined your request`,
    `Your request for €${toEuros(reqDoc.amountCents).toFixed(2)} was declined.`,
    { request_id: requestId });

  return publicRequest(store, store.get('paymentRequests', requestId));
}
