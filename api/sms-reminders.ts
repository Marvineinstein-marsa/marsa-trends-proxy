// Smart Kuku - Phase 4: daily SMS vaccine reminders (called by a Vercel cron job)

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function getDb() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT; // <-- change the name if your proxy uses a different variable
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
    const sa = JSON.parse(raw);
    if (sa.private_key) sa.private_key = String(sa.private_key).replace(/\\n/g, '\n');
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

const todayKampala = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const diffDays = (a: string, b: string) =>
  Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

const VACC = [
  { name: 'Newcastle (Lasota) eye drop', day: 7 },
  { name: 'Gumboro 1st dose', day: 14 },
  { name: 'Gumboro booster', day: 21 },
  { name: 'Newcastle booster', day: 28 },
  { name: 'Fowl pox wing web', day: 42 },
];

async function sendSms(to: string, message: string) {
  const base = process.env.AT_SANDBOX === 'true' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
  const r = await fetch(`${base}/version1/messaging`, {
    method: 'POST',
    headers: {
      apiKey: process.env.AT_API_KEY || '',
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ username: process.env.AT_USERNAME || '', to, message }).toString(),
  });
  if (!r.ok) throw new Error(`SMS HTTP ${r.status}`);
}

export default async function handler(req: any, res: any) {
  // Vercel cron sends: Authorization: Bearer <CRON_SECRET>
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.AT_API_KEY || !process.env.AT_USERNAME) {
    return res.status(500).json({ error: 'AT_API_KEY or AT_USERNAME is not set' });
  }

  try {
    const db = getDb();
    const today = todayKampala();
    const all = await db.collection('ussd_farmers').get();
    let sent = 0;
    let failed = 0;

    for (const doc of all.docs) {
      const f = doc.data() as any;
      if (f.smsReminders === false || !f.startDate || !f.phone) continue;
      const age = diffDays(f.startDate, today);
      const due = VACC.filter((v) => v.day - age === 1); // due tomorrow
      for (const v of due) {
        try {
          await sendSms(
            f.phone.startsWith('+') ? f.phone : `+${f.phone}`,
            `Smart Kuku: tomorrow your chicks are due for ${v.name}. Please confirm timing with your vet.`,
          );
          sent++;
        } catch (e) {
          failed++;
          console.error('sms failed', doc.id, e);
        }
      }
    }
    return res.status(200).json({ ok: true, sent, failed, farmers: all.size });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e?.message || 'error' });
  }
}
