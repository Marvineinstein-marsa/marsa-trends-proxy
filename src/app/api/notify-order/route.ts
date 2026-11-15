import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_ORIGINS = [
  'https://studio-wheat-tau.vercel.app',
  'https://studio-git-main-marvineinstein-marsas-projects.vercel.app',
];

function corsHeaders(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function getAdmin() {
  if (!admin.apps.length) {
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '')
      .replace(/^"|"$/g, '')
      .replace(/\\n/g, '\n');
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
    });
  }
  return admin;
}

const clip = (v: unknown, n: number) => String(v == null ? '' : v).slice(0, n);

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) });
}

export async function GET(req: NextRequest) {
  return NextResponse.json({ error: 'Use POST' }, { status: 405, headers: corsHeaders(req.headers.get('origin')) });
}

export async function POST(req: NextRequest) {
  const headers = corsHeaders(req.headers.get('origin'));
  const reply = (status: number, data: Record<string, unknown>) => NextResponse.json(data, { status, headers });

  try {
    const fb = getAdmin();
    const db = fb.firestore();
    const FieldValue = admin.firestore.FieldValue;

    // 1. The caller must be signed in.
    const authHeader = req.headers.get('authorization') || '';
    if (!authHeader.startsWith('Bearer ')) return reply(401, { error: 'Sign in required' });
    const decoded = await fb.auth().verifyIdToken(authHeader.slice(7)).catch(() => null);
    if (!decoded) return reply(401, { error: 'Invalid login' });

    const body = await req.json().catch(() => ({} as any));
    const orderId = String(body?.orderId || '');
    if (!/^[A-Za-z0-9_-]{6,60}$/.test(orderId)) return reply(400, { error: 'Bad order id' });

    // 2. The order must exist and the caller must be its buyer.
    const orderRef = db.collection('orders').doc(orderId);
    const order = await orderRef.get();
    if (!order.exists) return reply(404, { error: 'Order not found' });
    if (order.get('buyerId') !== decoded.uid) return reply(403, { error: 'Not your order' });

    // 3. Only once per order.
    if (order.get('sellerPushSentAt')) return reply(200, { ok: true, skipped: 'already sent' });

    const sellerId = String(order.get('sellerId') || '');
    if (!sellerId) return reply(200, { ok: true, skipped: 'no seller' });

    // 4. Find the seller's tokens: private place first, old public place as a fallback.
    const userRef = db.collection('users').doc(sellerId);
    const profileRef = db.collection('public_profiles').doc(sellerId);
    const [userSnap, profileSnap] = await Promise.all([userRef.get(), profileRef.get()]);

    const found = new Set<string>();
    const add = (v: unknown) => {
      if (typeof v === 'string' && v) found.add(v);
    };
    add(userSnap.get('fcmToken'));
    const list = userSnap.get('fcmTokens');
    if (Array.isArray(list)) list.forEach(add);
    add(profileSnap.get('fcmToken')); // OLD location: remove this line after the migration
    const tokens = Array.from(found);
    if (tokens.length === 0) return reply(200, { ok: true, skipped: 'seller has no push token' });

    // 5. The message text comes from the real order, not from the caller.
    const buyer = clip(order.get('buyerName'), 40) || 'A buyer';
    const qty = clip(order.get('quantity'), 12);
    const unit = clip(order.get('unit'), 20);
    const product = clip(order.get('productName'), 60);
    const bodyText =
      qty && product ? `${buyer} ordered ${qty} ${unit} of ${product}`.replace('  ', ' ') : `${buyer} placed an order`;

    const result = await fb.messaging().sendEachForMulticast({
      tokens,
      data: {
        type: 'new_order',
        orderId,
        title: 'New Order Received',
        body: bodyText,
        url: process.env.ORDERS_PATH || '/seller/orders',
        icon: process.env.PUSH_ICON_PATH || '/icon-192.png',
        tag: `order-${orderId}`,
      },
      webpush: { headers: { Urgency: 'high', TTL: '86400' } },
      android: { priority: 'high' },
    });

    // 6. Remove tokens that are no longer valid.
    const dead: string[] = [];
    result.responses.forEach((r, i) => {
      const code = (r.error && r.error.code) || '';
      if (!r.success && (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token'))) {
        dead.push(tokens[i]);
      }
    });
    if (dead.length > 0) {
      const userFix: Record<string, any> = {};
      if (dead.includes(userSnap.get('fcmToken'))) userFix.fcmToken = FieldValue.delete();
      if (Array.isArray(list)) userFix.fcmTokens = FieldValue.arrayRemove(...dead);
      if (Object.keys(userFix).length > 0) await userRef.update(userFix);
      if (dead.includes(profileSnap.get('fcmToken'))) await profileRef.update({ fcmToken: FieldValue.delete() });
    }

    if (result.successCount > 0) await orderRef.update({ sellerPushSentAt: FieldValue.serverTimestamp() });
    return reply(200, { ok: true, sent: result.successCount, failed: result.failureCount });
  } catch (e) {
    console.error('notify-order error', e);
    return reply(500, { error: 'Server error' });
  }
}
