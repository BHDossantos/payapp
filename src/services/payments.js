import { HttpError } from '../lib/http.js';
import { requireAmountCents, optionalString, toEuros } from '../lib/validate.js';
import { resolveUser, walletFor } from './accounts.js';

export function publicTransaction(store, tx, viewerId = null) {
  const sender = store.get('users', tx.senderUserId);
  const receiver = store.get('users', tx.receiverUserId);
  const label = (u) => (u ? `${u.firstName} ${u.lastName}` : 'Unknown');
  let direction = null;
  if (viewerId) direction = tx.senderUserId === viewerId ? 'sent' : 'received';
  return {
    transaction_id: tx.id,
    sender_user_id: tx.senderUserId,
    receiver_user_id: tx.receiverUserId,
    sender_name: label(sender),
    receiver_name: label(receiver),
    amount: toEuros(tx.amountCents),
    currency: tx.currency,
    status: tx.status,
    type: tx.type,
    reference: tx.reference,
    direction,
    created_at: tx.createdAt,
  };
}

// Moves money between two wallets atomically (single event-loop tick) and
// records a transaction. Shared by P2P sends, request fulfilment, and splits.
export function transfer(store, { senderUserId, receiverUserId, amountCents, currency, reference, type = 'p2p' }) {
  if (senderUserId === receiverUserId) {
    throw new HttpError(400, 'Cannot send money to yourself');
  }
  const senderWallet = walletFor(store, senderUserId);
  const receiverWallet = walletFor(store, receiverUserId);
  if (!senderWallet) throw new HttpError(404, 'Sender wallet not found');
  if (!receiverWallet) throw new HttpError(404, 'Recipient wallet not found');
  if (senderWallet.status !== 'active') throw new HttpError(403, 'Sender wallet is not active');
  if (receiverWallet.status !== 'active') throw new HttpError(403, 'Recipient wallet is not active');
  if (senderWallet.currency !== receiverWallet.currency) {
    throw new HttpError(400, 'Cross-currency transfers are not yet supported');
  }
  if (senderWallet.balanceCents < amountCents) {
    const tx = store.insert('transactions', {
      senderUserId,
      receiverUserId,
      amountCents,
      currency,
      status: 'failed',
      type,
      reference: reference || null,
      createdAt: new Date().toISOString(),
    });
    throw new HttpError(402, 'Insufficient balance', { transaction_id: tx.id });
  }

  store.update('wallets', senderWallet.id, { balanceCents: senderWallet.balanceCents - amountCents });
  store.update('wallets', receiverWallet.id, { balanceCents: receiverWallet.balanceCents + amountCents });

  return store.insert('transactions', {
    senderUserId,
    receiverUserId,
    amountCents,
    currency,
    status: 'completed',
    type,
    reference: reference || null,
    createdAt: new Date().toISOString(),
  });
}

export function sendMoney(store, senderUserId, body) {
  const amountCents = requireAmountCents(body);
  const reference = optionalString(body, 'note', { max: 140 });
  const recipient = resolveUser(store, {
    username: body.username,
    email: body.email,
    phone: body.phone,
  });
  if (!recipient) {
    throw new HttpError(404, 'No EuroFlow user matches that handle');
  }
  const senderWallet = walletFor(store, senderUserId);
  const tx = transfer(store, {
    senderUserId,
    receiverUserId: recipient.id,
    amountCents,
    currency: senderWallet.currency,
    reference,
    type: 'p2p',
  });
  return publicTransaction(store, tx, senderUserId);
}

export function history(store, userId, query = {}) {
  let txs = store.filter(
    'transactions',
    (t) => t.senderUserId === userId || t.receiverUserId === userId,
  );
  if (query.status) {
    txs = txs.filter((t) => t.status === query.status);
  }
  if (query.direction === 'sent') txs = txs.filter((t) => t.senderUserId === userId);
  if (query.direction === 'received') txs = txs.filter((t) => t.receiverUserId === userId);
  txs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return txs.map((t) => publicTransaction(store, t, userId));
}
