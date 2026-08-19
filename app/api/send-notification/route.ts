import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';

const ALLOWED_ORIGINS = [
  'https://studio-wheat-tau.vercel.app',
  'https://studio-git-main-marvineinstein-marsas-projects.vercel.app',
];

function corsHeaders(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) });
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');
  const headers = corsHeaders(origin);

  try {
    const body = await req.json();
    const { tokens, title, message, url } = body as {
      tokens: string[];
      title: string;
      message: string;
      url?: string;
    };

    if (!tokens || tokens.length === 0) {
      return NextResponse.json({ success: true, sent: 0 }, { headers });
    }

    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: {
        title,
        body: message,
      },
      webpush: {
        fcmOptions: {
          link: url || '/',
        },
        notification: {
          icon: '/smart_kuku.png',
        },
      },
    });

    return NextResponse.json(
      { success: true, sent: response.successCount, failed: response.failureCount },
      { headers }
    );
  } catch (err: any) {
    console.error('Push notification send failed:', err);
    return NextResponse.json({ success: false, error: err?.message || 'Unknown error' }, { status: 500, headers });
  }
    }
