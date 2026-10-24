import { HttpError } from '../lib/http.js';
import { requireString, optionalString } from '../lib/validate.js';
import { publicUser } from './accounts.js';

const normalizePhone = (p) => (p || '').replace(/[\s-]/g, '');
const normalizeEmail = (e) => (e || '').trim().toLowerCase();

// Finds the EuroFlow user (if any) behind a contact's phone or email.
function matchUser(store, contact) {
  if (contact.email) {
    const u = store.find('users', (x) => x.email === contact.email);
    if (u) return u;
  }
  if (contact.phone) {
    const u = store.find('users', (x) => x.phone === contact.phone);
    if (u) return u;
  }
  return null;
}

// Serializes a stored contact, resolving membership live so a contact who joins
// later automatically shows as on-platform without a re-sync.
export function publicContact(store, contact) {
  const user = matchUser(store, contact);
  return {
    contact_id: contact.id,
    name: contact.name,
    phone: contact.phone,
    email: contact.email,
    on_platform: !!user,
    user: user ? { user_id: user.id, name: `${user.firstName} ${user.lastName}`, username: user.username } : null,
  };
}

// Upserts a batch of address-book entries for the owner. Each entry needs a phone
// or email; dedupe is by normalized phone-or-email within the owner's contacts.
export function syncContacts(store, ownerId, body) {
  if (!Array.isArray(body.contacts)) {
    throw new HttpError(400, 'Provide a "contacts" array');
  }
  if (body.contacts.length > 2000) {
    throw new HttpError(400, 'Too many contacts in one sync (max 2000)');
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;
  const existing = store.filter('contacts', (c) => c.ownerId === ownerId);

  for (const entry of body.contacts) {
    const phone = normalizePhone(entry.phone);
    const email = normalizeEmail(entry.email);
    if (!phone && !email) { skipped += 1; continue; }
    const name = (typeof entry.name === 'string' && entry.name.trim()) ? entry.name.trim().slice(0, 120) : null;

    const match = existing.find((c) => (phone && c.phone === phone) || (email && c.email === email));
    if (match) {
      store.update('contacts', match.id, { name: name || match.name, phone: phone || match.phone, email: email || match.email });
      updated += 1;
    } else {
      const rec = store.insert('contacts', { ownerId, name, phone, email, createdAt: new Date().toISOString() });
      existing.push(rec);
      added += 1;
    }
  }

  const contacts = listContacts(store, ownerId, {});
  return {
    added,
    updated,
    skipped,
    total: contacts.length,
    on_platform: contacts.filter((c) => c.on_platform),
  };
}

export function listContacts(store, ownerId, { onPlatform = false } = {}) {
  let items = store
    .filter('contacts', (c) => c.ownerId === ownerId)
    .map((c) => publicContact(store, c));
  if (onPlatform) items = items.filter((c) => c.on_platform);
  items.sort((a, b) => {
    // On-platform first, then alphabetical by name/handle.
    if (a.on_platform !== b.on_platform) return a.on_platform ? -1 : 1;
    return (a.name || a.email || a.phone || '').localeCompare(b.name || b.email || b.phone || '');
  });
  return items;
}

export function deleteContact(store, ownerId, id) {
  const c = store.get('contacts', id);
  if (!c || c.ownerId !== ownerId) throw new HttpError(404, 'Contact not found');
  delete store.data.contacts[id];
  store.persist();
  return { deleted: true };
}

const DIRECTORY_LIMIT = 20;

// Public user directory for finding someone to pay. Exact match on email/phone;
// prefix match on username or name. Never exposes contact details of others —
// only name + username. The caller is excluded from results.
export function searchDirectory(store, rawQuery, callerId) {
  const q = requireString({ q: rawQuery }, 'q', { min: 2, max: 80 }).toLowerCase();
  const asEntry = (u) => ({ user_id: u.id, name: `${u.firstName} ${u.lastName}`, username: u.username });

  let matches;
  if (q.includes('@')) {
    matches = store.filter('users', (u) => u.email === q);
  } else if (/^\+?[0-9]{4,}$/.test(q.replace(/[\s-]/g, ''))) {
    // Compare with the leading "+" stripped so "351…" and "+351…" both match
    // (a query-string "+" is often decoded to a space and lost).
    const bare = q.replace(/[\s-]/g, '').replace(/^\+/, '');
    matches = store.filter('users', (u) => u.phone.replace(/^\+/, '') === bare);
  } else {
    matches = store.filter('users', (u) => (u.username && u.username.startsWith(q))
      || u.firstName.toLowerCase().startsWith(q)
      || u.lastName.toLowerCase().startsWith(q));
  }
  return matches
    .filter((u) => u.id !== callerId)
    .slice(0, DIRECTORY_LIMIT)
    .map(asEntry);
}

// Referral helper: build an invite payload for a non-member contact.
export function inviteText(store, ownerId, body) {
  const name = optionalString(body, 'name', { max: 120 });
  const owner = store.get('users', ownerId);
  const link = `${process.env.EUROFLOW_PAY_URL || 'https://euroflow.app/pay'}/../join?ref=${owner.username || owner.id}`;
  return {
    message: `${owner.firstName} invited you to EuroFlow — send and receive money instantly across Europe.${name ? ` Hi ${name}!` : ''}`,
    link,
  };
}
