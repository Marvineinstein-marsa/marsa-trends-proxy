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

    // 1. Only signed-in users (not guests) can send.
    const authHeader = req.headers.get('authorization') || '';
    if (!authHeader.startsWith('Bearer ')) return fail(401, 'Sign in required');
    const decoded = await fb.auth().verifyIdToken(authHeader.slice(7)).catch(() => null);
    if (!decoded) return fail(401, 'Invalid login');
    if (decoded.firebase?.sign_in_provider === 'anonymous') return fail(403, 'Guests cannot send notifications');
    if (tooMany(decoded.uid)) return fail(429, 'Too many notifications, slow down');

    // 2. Check and clean the request.
    const body = await req.json().catch(() => ({} as any));
    const rawTokens: unknown[] = Array.isArray(body?.tokens) ? body.tokens : [];
    const tokens = Array.from(
      new Set<string>(
        rawTokens.filter((t): t is string => typeof t === 'string' && t.length > 20 && t.length < 4096)
      )
    ).slice(0, 10);
    if (tokens.length === 0) return NextResponse.json({ success: true, sent: 0 }, { headers });

    const title = clip(body?.title, 80) || 'Smart Kuku';
    const message = clip(body?.message, 200);
    const rawUrl = typeof body?.url === 'string' ? body.url : '/';
    const url = rawUrl.startsWith('/') && !rawUrl.startsWith('//') ? rawUrl.slice(0, 300) : '/';

    // 3. Send as a data message: the app's service worker shows it with the Smart Kuku name and icon.
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

    return NextResponse.json(
      { success: true, sent: response.successCount, failed: response.failureCount },
      { headers }
    );
  } catch (err: any) {
    console.error('Push notification send failed:', err);
    return fail(500, 'Server error');
  }
}
