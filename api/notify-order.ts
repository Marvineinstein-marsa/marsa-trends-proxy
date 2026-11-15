// Smart Kuku: secure push to a seller when a buyer places an order.
// The buyer's app sends only the order id + their login token.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';

function init() {
  if (!getApps().length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '')
      .replace(/^"|"$/g, '')
      .replace(/\\n/g, '\n');
    if (!projectId || !clientEmail || !privateKey) throw new Error('Firebase server credentials are not set');
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  }
}

const clip = (v: unknown, n: number) => String(v ?? '').slice(0, n);

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    init();

    // 1. The caller must be signed in.
    const bearer = String(req.headers.authorization || '');
    if (!bearer.startsWith('Bearer ')) return res.status(401).json({ error: 'Sign in required' });
    const decoded = await getAuth().verifyIdToken(bearer.slice(7));

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const orderId = String(body?.orderId || '');
    if (!/^[A-Za-z0-9_-]{6,60}$/.test(orderId)) return res.status(400).json({ error: 'Bad order id' });

    const db = getFirestore();

    // 2. The order must exist and the caller must be its buyer.
    const orderRef = db.collection('orders').doc(orderId);
    const order = await orderRef.get();
    if (!order.exists) return res.status(404).json({ error: 'Order not found' });
    if (order.get('buyerId') !== decoded.uid) return res.status(403).json({ error: 'Not your order' });

    // 3. Only once per order.
    if (order.get('sellerPushSentAt')) return res.status(200).json({ ok: true, skipped: 'already sent' });

    const sellerId = String(order.get('sellerId') || '');
    if (!sellerId) return res.status(200).json({ ok: true, skipped: 'no seller' });

    // 4. Find the seller's tokens: new private place first, old public place as a fallback.
    const userRef = db.collection('users').doc(sellerId);
    const profileRef = db.collection('public_profiles').doc(sellerId);
    const [userSnap, profileSnap] = await Promise.all([userRef.get(), profileRef.get()]);

    const tokens = new Set<string>();
    const add = (v: unknown) => { if (typeof v === 'string' && v) tokens.add(v); };
    add(userSnap.get('fcmToken'));
    const list = userSnap.get('fcmTokens');
    if (Array.isArray(list)) list.forEach(add);
    add(profileSnap.get('fcmToken')); // OLD location: remove this line after the migration
    if (tokens.size === 0) return res.status(200).json({ ok: true, skipped: 'seller has no push token' });

    // 5. Message text comes from the real order, not from the caller.
    const buyer = clip(order.get('buyerName'), 40) || 'A buyer';
    const qty = clip(order.get('quantity'), 12);
    const unit = clip(order.get('unit'), 20);
    const product = clip(order.get('productName'), 60);
    const bodyText = qty && product ? `${buyer} ordered ${qty} ${unit} of ${product}`.replace('  ', ' ') : `${buyer} placed an order`;

    const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
    const ordersPath = process.env.ORDERS_PATH || '/seller/orders';
    const icon = appUrl && process.env.PUSH_ICON_PATH ? `${appUrl}${process.env.PUSH_ICON_PATH}` : undefined;
    const badge = appUrl && process.env.PUSH_BADGE_PATH ? `${appUrl}${process.env.PUSH_BADGE_PATH}` : undefined;

    const all = [...tokens];
    const result = await getMessaging().sendEachForMulticast({
      tokens: all,
      notification: { title: 'New Order Received', body: bodyText },
      data: { type: 'new_order', orderId, url: ordersPath },
      webpush: {
        headers: { Urgency: 'high' },
        notification: { ...(icon ? { icon } : {}), ...(badge ? { badge } : {}), tag: `order-${orderId}` },
        ...(appUrl ? { fcmOptions: { link: `${appUrl}${ordersPath}` } } : {}),
      },
      android: { priority: 'high' },
    });

    // 6. Remove tokens that are no longer valid, from both places.
    const dead = new Set<string>();
    result.responses.forEach((r, i) => {
      const code = r.error?.code || '';
      if (!r.success && (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token'))) {
        dead.add(all[i]);
      }
    });
    if (dead.size) {
      const userFix: Record<string, unknown> = {};
      if (dead.has(userSnap.get('fcmToken'))) userFix.fcmToken = FieldValue.delete();
      if (Array.isArray(list)) userFix.fcmTokens = FieldValue.arrayRemove(...dead);
      if (Object.keys(userFix).length) await userRef.update(userFix);
      if (dead.has(profileSnap.get('fcmToken'))) await profileRef.update({ fcmToken: FieldValue.delete() });
    }

    if (result.successCount > 0) await orderRef.update({ sellerPushSentAt: FieldValue.serverTimestamp() });
    return res.status(200).json({ ok: true, sent: result.successCount, failed: result.failureCount });
  } catch (e: any) {
    console.error('notify-order error', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
