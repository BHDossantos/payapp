import { HttpError } from '../lib/http.js';
import { hashPassword, verifyPassword, signToken } from '../lib/crypto.js';
import {
  requireString, optionalString, requireEmail, requirePhone, normalizeCurrency, toEuros,
} from '../lib/validate.js';

const USERNAME_RE = /^[a-z0-9_.]{3,30}$/;

// Emails listed here are granted admin rights at registration. Lets you bootstrap
// a compliance/admin operator without a separate provisioning step.
const ADMIN_EMAILS = new Set(
  (process.env.EUROFLOW_ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

export function publicUser(user) {
  if (!user) return null;
  return {
    user_id: user.id,
    first_name: user.firstName,
    last_name: user.lastName,
    phone: user.phone,
    email: user.email,
    username: user.username,
    country: user.country,
    kyc_status: user.kycStatus,
    is_admin: !!user.isAdmin,
    created_at: user.createdAt,
  };
}

export function publicWallet(wallet) {
  if (!wallet) return null;
  return {
    wallet_id: wallet.id,
    user_id: wallet.userId,
    balance: toEuros(wallet.balanceCents),
    balance_cents: wallet.balanceCents,
    currency: wallet.currency,
    status: wallet.status,
  };
}

export function walletFor(store, userId) {
  return store.find('wallets', (w) => w.userId === userId);
}

// Resolves a recipient by username, email, or phone — the three P2P handles.
export function resolveUser(store, { username, email, phone }) {
  if (username) {
    const u = username.toLowerCase();
    return store.find('users', (x) => x.username === u);
  }
  if (email) {
    const e = email.toLowerCase();
    return store.find('users', (x) => x.email === e);
  }
  if (phone) {
    const p = phone.replace(/[\s-]/g, '');
    return store.find('users', (x) => x.phone === p);
  }
  return null;
}

export function register(store, body) {
  const firstName = requireString(body, 'first_name', { max: 80 });
  const lastName = requireString(body, 'last_name', { max: 80 });
  const email = requireEmail(body);
  const phone = requirePhone(body);
  const country = requireString(body, 'country', { min: 2, max: 2 }).toUpperCase();
  const password = requireString(body, 'password', { min: 8, max: 200 });
  let username = optionalString(body, 'username', { max: 30 });
  if (username) {
    username = username.toLowerCase();
    if (!USERNAME_RE.test(username)) {
      throw new HttpError(400, 'Username must be 3-30 chars: a-z, 0-9, "_" or "."');
    }
  }
  const currency = normalizeCurrency(body);

  if (store.find('users', (u) => u.email === email)) {
    throw new HttpError(409, 'A user with that email already exists');
  }
  if (store.find('users', (u) => u.phone === phone)) {
    throw new HttpError(409, 'A user with that phone already exists');
  }
  if (username && store.find('users', (u) => u.username === username)) {
    throw new HttpError(409, 'That username is taken');
  }

  const user = store.insert('users', {
    firstName,
    lastName,
    email,
    phone,
    username,
    country,
    kycStatus: 'unverified',
    isAdmin: ADMIN_EMAILS.has(email),
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  });

  const wallet = store.insert('wallets', {
    userId: user.id,
    balanceCents: 0,
    currency,
    status: 'active',
    createdAt: new Date().toISOString(),
  });

  return {
    token: signToken({ sub: user.id }),
    user: publicUser(user),
    wallet: publicWallet(wallet),
  };
}

export function login(store, body) {
  const password = requireString(body, 'password', { max: 200 });
  // Allow login with any one of the three identifiers.
  const identifier = body.email || body.phone || body.username;
  if (!identifier) {
    throw new HttpError(400, 'Provide one of: email, phone, username');
  }
  const user = resolveUser(store, {
    email: body.email,
    phone: body.phone,
    username: body.username,
  });
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new HttpError(401, 'Invalid credentials');
  }
  return {
    token: signToken({ sub: user.id }),
    user: publicUser(user),
    wallet: publicWallet(walletFor(store, user.id)),
  };
}

// Demo/admin helper: credit a wallet (stands in for a top-up via Stripe/Adyen).
export function topUp(store, userId, cents) {
  const wallet = walletFor(store, userId);
  if (!wallet) throw new HttpError(404, 'Wallet not found');
  store.update('wallets', wallet.id, { balanceCents: wallet.balanceCents + cents });
  return publicWallet(walletFor(store, userId));
}

export function verifyKyc(store, userId) {
  const user = store.get('users', userId);
  if (!user) throw new HttpError(404, 'User not found');
  store.update('users', userId, { kycStatus: 'verified' });
  return publicUser(store.get('users', userId));
}
