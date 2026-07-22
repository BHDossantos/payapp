import { HttpError } from '../lib/http.js';

// In-app notifications. Each record targets a single recipient user and carries
// a type, human-readable title/body, and an optional `data` bag linking back to
// the originating entity (transaction, request, split, merchant, …).
export function publicNotification(n) {
  return {
    notification_id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    data: n.data || {},
    read: !!n.read,
    created_at: n.createdAt,
  };
}

// Fire-and-forget: create a notification for `userId`. Returns the record.
export function notify(store, userId, type, title, body, data = {}) {
  if (!userId) return null;
  return store.insert('notifications', {
    userId,
    type,
    title,
    body,
    data,
    read: false,
    createdAt: new Date().toISOString(),
  });
}

export function listNotifications(store, userId, { unread = false } = {}) {
  let items = store.filter('notifications', (n) => n.userId === userId);
  if (unread) items = items.filter((n) => !n.read);
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items.map(publicNotification);
}

export function unreadCount(store, userId) {
  return store.filter('notifications', (n) => n.userId === userId && !n.read).length;
}

export function markRead(store, userId, id) {
  const n = store.get('notifications', id);
  if (!n || n.userId !== userId) throw new HttpError(404, 'Notification not found');
  if (!n.read) store.update('notifications', id, { read: true });
  return publicNotification(store.get('notifications', id));
}

export function markAllRead(store, userId) {
  const unread = store.filter('notifications', (n) => n.userId === userId && !n.read);
  for (const n of unread) store.update('notifications', n.id, { read: true });
  return { marked: unread.length };
}
