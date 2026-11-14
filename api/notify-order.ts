// Smart Kuku: push notification to a seller when a buyer places an order.
// The buyer's app calls this right after creating the order.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';

function init() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT; // <-- change the name if your proxy uses a different variable
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
    const sa = JSON.parse(raw);
    if (sa.private_key) sa.private_key = String(sa.private_key).replace(/\\n/g, '\n');
    initializeApp({ credential: cert(sa) });
  }
}

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    init();

    // 1. Who is calling? Must be a signed-in user.
    const bearer = String(req.headers.authorization || '');
    if (!bearer.startsWith('Bearer ')) return res.status(401).json({ error: 'Sign in required' });
    const decoded = await getAuth().verifyIdToken(bearer.slice(7));

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const orderId = String(body?.orderId || '');
    if (!/^[A-Za-z0-9_-]{6,60}$/.test(orderId)) return res.status(400).json({ error: 'Bad order id' });

    const db = getFirestore();

    // 2. The order must exist and belong to the caller as the buyer.
    const orderRef = db.collection('orders').doc(orderId);
    const order = await orderRef.get();
    if (!order.exists) return res.status(404).json({ error: 'Order not found' });
    if (order.get('buyerId') !== decoded.uid) return res.status(403).json({ error: 'Not your order' });

    // 3. Only notify once per order.
    if (order.get('sellerPushSentAt')) return res.status(200).json({ ok: true, skipped: 'already sent' });

    const sellerId = String(order.get('sellerId') || '');
    if (!sellerId) return res.status(200).json({ ok: true, skipped: 'no seller' });

    // 4. Find the seller's push tokens.
    const seller = await db.collection('users').doc(sellerId).get();
    const tokens = new Set<string>();
    const single = seller.get('fcmToken');
    if (typeof single === 'string' && single) tokens.add(single);
    const list = seller.get('fcmTokens');
    if (Array.isArray(list)) list.forEach((t: unknown) => typeof t === 'string' && t && tokens.add(t));
    if (tokens.size === 0) return res.status(200).json({ ok: true, skipped: 'seller has no push token' });

    // 5. Send.
    const buyerName = String(order.get('buyerName') || '').slice(0, 40) || 'A buyer';
    const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
    const ordersPath = process.env.ORDERS_PATH || '/orders';

    const result = await getMessaging().sendEachForMulticast({
      tokens: [...tokens],
      notification: { title: 'New order', body: `${buyerName} placed an order. Tap to view it.` },
      data: { type: 'new_order', orderId, url: ordersPath },
      webpush: appUrl ? { fcmOptions: { link: `${appUrl}${ordersPath}` } } : undefined,
      android: { priority: 'high' },
    });

    // 6. Remove tokens that are no longer valid.
    const dead: string[] = [];
    result.responses.forEach((r, i) => {
      const code = r.error?.code || '';
      if (!r.success && (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token'))) {
        dead.push([...tokens][i]);
      }
    });
    if (dead.length) {
      const fix: Record<string, unknown> = {};
      if (dead.includes(single)) fix.fcmToken = FieldValue.delete();
      if (Array.isArray(list)) fix.fcmTokens = FieldValue.arrayRemove(...dead);
      if (Object.keys(fix).length) await seller.ref.update(fix);
    }

    if (result.successCount > 0) await orderRef.update({ sellerPushSentAt: FieldValue.serverTimestamp() });
    return res.status(200).json({ ok: true, sent: result.successCount, failed: result.failureCount });
  } catch (e: any) {
    console.error('notify-order error', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
