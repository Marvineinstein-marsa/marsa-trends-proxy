import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EXACT_ORIGINS = [
  'https://studio-wheat-tau.vercel.app',
  'https://studio-git-main-marvineinstein-marsas-projects.vercel.app',
];
// Your Vercel preview addresses look like studio-<hash>-marvineinstein-marsas-projects.vercel.app
const PREVIEW_SUFFIX = '-marvineinstein-marsas-projects.vercel.app';

function isAllowedOrigin(origin: string | null): origin is string {
  if (!origin) return false;
  if (EXACT_ORIGINS.includes(origin)) return true;
  const extra = (process.env.EXTRA_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (extra.includes(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost') return true;
    if (u.protocol === 'https:' && u.hostname.startsWith('studio-') && u.hostname.endsWith(PREVIEW_SUFFIX)) return true;
  } catch {}
  return false;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
  if (isAllowedOrigin(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

// Firebase starts only when a request arrives, so the build never touches the credentials.
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

// Best-effort limit per user: 20 sends a minute (resets if the server instance restarts).
const hits = new Map<string, number[]>();
function tooMany(uid: string) {
  const now = Date.now();
  const recent = (hits.get(uid) || []).filter((t) => now - t < 60000);
  recent.push(now);
  hits.set(uid, recent);
  return recent.length > 20;
}

const clip = (v: unknown, n: number) => String(v == null ? '' : v).slice(0, n);
const validToken = (t: unknown): t is string => typeof t === 'string' && t.length > 20 && t.length < 4096;

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) });
}

export async function GET(req: NextRequest) {
  return NextResponse.json({ error: 'Use POST' }, { status: 405, headers: corsHeaders(req.headers.get('origin')) });
}

export async function POST(req: NextRequest) {
  const headers = corsHeaders(req.headers.get('origin'));
  const fail = (status: number, error: string) =>
    NextResponse.json({ success: false, error }, { status, headers });

  try {
    const fb = getAdmin();
    const db = fb.firestore();

    // 1. Only signed-in users (not guests) can send.
    const authHeader = req.headers.get('authorization') || '';
    if (!authHeader.startsWith('Bearer ')) return fail(401, 'Sign in required');
    const decoded = await fb.auth().verifyIdToken(authHeader.slice(7)).catch(() => null);
    if (!decoded) return fail(401, 'Invalid login');
    if (decoded.firebase?.sign_in_provider === 'anonymous') return fail(403, 'Guests cannot send notifications');
    if (tooMany(decoded.uid)) return fail(429, 'Too many notifications, slow down');

    // 2. Check and clean the request.
    const body = await req.json().catch(() => ({} as any));
    let title = clip(body?.title, 80) || 'Smart Kuku';
    const message = clip(body?.message, 200);
    const rawUrl = typeof body?.url === 'string' ? body.url : '/';
    const url = rawUrl.startsWith('/') && !rawUrl.startsWith('//') ? rawUrl.slice(0, 300) : '/';

    // 3. Work out who to notify.
    const tokenOwner = new Map<string, string>(); // token -> owner uid (chat mode only, used for cleanup)
    let tokens: string[] = [];

    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';
    if (conversationId) {
      // Chat mode: the server finds the other person and all of their devices.
      if (!/^[^/]{1,300}$/.test(conversationId)) return fail(400, 'Bad conversation');
      const convSnap = await db.collection('conversations').doc(conversationId).get();
      const participants: string[] = Array.isArray(convSnap.data()?.participants) ? convSnap.data()!.participants : [];
      if (!convSnap.exists || !participants.includes(decoded.uid)) return fail(403, 'Not in this chat');

      // Use the sender's current profile name when there is one.
      const senderProfile = await db.collection('public_profiles').doc(decoded.uid).get();
      const senderName = clip(senderProfile.data()?.name, 80).trim();
      if (senderName) title = senderName;

      for (const uid of participants.filter((p) => p !== decoded.uid)) {
        const [uSnap, pSnap] = await Promise.all([
          db.collection('users').doc(uid).get(),
          db.collection('public_profiles').doc(uid).get(),
        ]);
        const u = uSnap.data() || {};
        // Respect the receiver's Notification Preferences
        if (u.notificationPrefs && u.notificationPrefs.messages === false) continue;

        const list: unknown[] = [];
        if (Array.isArray(u.fcmTokens)) list.push(...u.fcmTokens);
        list.push(pSnap.data()?.fcmToken);
        for (const t of list) {
          if (validToken(t) && !tokenOwner.has(t)) tokenOwner.set(t, uid);
        }
      }
      tokens = Array.from(tokenOwner.keys()).slice(0, 10);
    } else {
      // Old mode (post notifications): the caller supplies the tokens.
      const rawTokens: unknown[] = Array.isArray(body?.tokens) ? body.tokens : [];
      tokens = Array.from(new Set<string>(rawTokens.filter(validToken))).slice(0, 10);
    }

    if (tokens.length === 0) return NextResponse.json({ success: true, sent: 0 }, { headers });

    // 4. Send as a data message: the app's service worker shows it with the Smart Kuku name and icon.
    const response = await fb.messaging().sendEachForMulticast({
      tokens,
      data: {
        title,
        body: message,
        url,
        icon: process.env.PUSH_ICON_PATH || '/icon-192.png',
        tag: `msg-${Date.now()}`,
      },
      webpush: { headers: { Urgency: 'high', TTL: '86400' } },
      android: { priority: 'high' },
    });

    // 5. Remove tokens that are dead, so old devices stop failing silently.
    if (tokenOwner.size > 0) {
      const cleanup: Promise<unknown>[] = [];
      response.responses.forEach((r, i) => {
        const code = r.error?.code;
        if (r.success || (code !== 'messaging/registration-token-not-registered' && code !== 'messaging/invalid-registration-token')) return;
        const token = tokens[i];
        const uid = tokenOwner.get(token);
        if (!uid) return;
        cleanup.push(
          db.collection('users').doc(uid).update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(token) }).catch(() => {})
        );
        cleanup.push(
          db.collection('public_profiles').doc(uid).get().then((s) => {
            if (s.data()?.fcmToken === token) return s.ref.update({ fcmToken: admin.firestore.FieldValue.delete() });
          }).catch(() => {})
        );
      });
      await Promise.all(cleanup);
    }

    return NextResponse.json(
      { success: true, sent: response.successCount, failed: response.failureCount },
      { headers }
    );
  } catch (err: any) {
    console.error('Push notification send failed:', err);
    return fail(500, 'Server error');
  }
}
