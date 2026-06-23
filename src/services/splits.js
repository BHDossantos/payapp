import { HttpError } from '../lib/http.js';
import { requireString, requireAmountCents, toEuros } from '../lib/validate.js';
import { resolveUser, walletFor } from './accounts.js';
import { transfer, publicTransaction } from './payments.js';
import { notify } from './notifications.js';

function publicParticipant(store, p) {
  const user = store.get('users', p.userId);
  return {
    participant_id: p.id,
    group_id: p.groupId,
    user_id: p.userId,
    name: user ? `${user.firstName} ${user.lastName}` : 'Unknown',
    amount: toEuros(p.amountCents),
    status: p.status,
  };
}

export function publicGroup(store, group) {
  const participants = store.filter('splitParticipants', (p) => p.groupId === group.id);
  const owedCents = participants.reduce((sum, p) => sum + p.amountCents, 0);
  const settledCents = participants
    .filter((p) => p.status === 'paid')
    .reduce((sum, p) => sum + p.amountCents, 0);
  return {
    group_id: group.id,
    creator_id: group.creatorId,
    name: group.name,
    total: toEuros(owedCents),
    settled: toEuros(settledCents),
    fully_settled: participants.length > 0 && participants.every((p) => p.status === 'paid'),
    created_at: group.createdAt,
    participants: participants.map((p) => publicParticipant(store, p)),
  };
}

// Creates a split. The creator is the collector; each participant owes a share.
// `participants` is an array of { handle..., amount } OR, if `split === "equal"`
// and `total` is given, the amount is divided evenly (remainder to the first).
export function createSplit(store, creatorId, body) {
  const name = requireString(body, 'name', { max: 120 });
  if (!Array.isArray(body.participants) || body.participants.length === 0) {
    throw new HttpError(400, 'Provide a non-empty "participants" array');
  }

  // Resolve every participant up front so we fail before writing anything.
  const resolved = body.participants.map((entry, i) => {
    const user = resolveUser(store, {
      username: entry.username,
      email: entry.email,
      phone: entry.phone,
    });
    if (!user) throw new HttpError(404, `participants[${i}] does not match any user`);
    return { user, entry };
  });

  const group = store.insert('splitGroups', {
    creatorId,
    name,
    createdAt: new Date().toISOString(),
  });

  let shares;
  if (body.split === 'equal') {
    const totalCents = requireAmountCents(body, 'total');
    const n = resolved.length;
    const base = Math.floor(totalCents / n);
    const remainder = totalCents - base * n;
    shares = resolved.map((_r, i) => base + (i === 0 ? remainder : 0));
  } else {
    shares = resolved.map(({ entry }, i) => requireAmountCents(entry, 'amount')
      || (() => { throw new HttpError(400, `participants[${i}].amount is required`); })());
  }

  const creator = store.get('users', creatorId);
  resolved.forEach(({ user }, i) => {
    // The creator's own share is auto-settled (they are collecting, not paying).
    const isCreator = user.id === creatorId;
    store.insert('splitParticipants', {
      groupId: group.id,
      userId: user.id,
      amountCents: shares[i],
      status: isCreator ? 'paid' : 'pending',
    });
    if (!isCreator) {
      notify(store, user.id, 'split_request',
        `You owe €${toEuros(shares[i]).toFixed(2)} for “${name}”`,
        `${creator.firstName} ${creator.lastName} added you to a bill split.`,
        { group_id: group.id, amount: toEuros(shares[i]) });
    }
  });

  return publicGroup(store, group);
}

export function getSplit(store, groupId) {
  const group = store.get('splitGroups', groupId);
  if (!group) throw new HttpError(404, 'Split group not found');
  return publicGroup(store, group);
}

export function listSplits(store, userId) {
  const asParticipant = new Set(
    store.filter('splitParticipants', (p) => p.userId === userId).map((p) => p.groupId),
  );
  return store
    .filter('splitGroups', (g) => g.creatorId === userId || asParticipant.has(g.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((g) => publicGroup(store, g));
}

// A participant pays their share to the group creator.
export function paySplitShare(store, userId, groupId) {
  const group = store.get('splitGroups', groupId);
  if (!group) throw new HttpError(404, 'Split group not found');
  const participant = store.find(
    'splitParticipants',
    (p) => p.groupId === groupId && p.userId === userId,
  );
  if (!participant) throw new HttpError(403, 'You are not part of this split');
  if (participant.status === 'paid') throw new HttpError(409, 'Your share is already paid');

  const wallet = walletFor(store, userId);
  const tx = transfer(store, {
    senderUserId: userId,
    receiverUserId: group.creatorId,
    amountCents: participant.amountCents,
    currency: wallet.currency,
    reference: `Split: ${group.name}`,
    type: 'split',
  });
  store.update('splitParticipants', participant.id, { status: 'paid' });

  const payer = store.get('users', userId);
  notify(store, group.creatorId, 'split_share_paid',
    `${payer.firstName} paid their share`,
    `€${toEuros(participant.amountCents).toFixed(2)} towards “${group.name}”.`,
    { group_id: groupId, transaction_id: tx.id, amount: toEuros(participant.amountCents) });

  return {
    group: publicGroup(store, group),
    transaction: publicTransaction(store, tx, userId),
  };
}
