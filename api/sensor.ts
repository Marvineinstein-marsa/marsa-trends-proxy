// Smart Kuku - Phase 5: sensor pod ingest (ESP32 -> Firestore) with alerts

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

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

const DEFAULTS = { tempMax: 32, tempMin: 18, humMax: 75, humMin: 40, gasMax: 2000 };

async function sendSms(to: string, message: string) {
  if (!process.env.AT_API_KEY || !process.env.AT_USERNAME) return;
  const base = process.env.AT_SANDBOX === 'true' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
  await fetch(`${base}/version1/messaging`, {
    method: 'POST',
    headers: { apiKey: process.env.AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: process.env.AT_USERNAME, to, message }).toString(),
  });
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  const deviceId = String(b?.deviceId || '');
  const token = String(b?.token || '');
  const temp = Number(b?.temp);
  const hum = Number(b?.hum);
  const gas = b?.gas === undefined ? null : Number(b.gas);

  if (!/^[A-Za-z0-9-]{6,40}$/.test(deviceId) || token.length < 10) return res.status(400).json({ error: 'Bad device' });
  if (!Number.isFinite(temp) || temp < -20 || temp > 80) return res.status(400).json({ error: 'Bad temp' });
  if (!Number.isFinite(hum) || hum < 0 || hum > 100) return res.status(400).json({ error: 'Bad humidity' });
  if (gas !== null && (!Number.isFinite(gas) || gas < 0 || gas > 4095)) return res.status(400).json({ error: 'Bad gas' });

  try {
    const db = getDb();
    const ref = db.collection('devices').doc(deviceId);
    const snap = await ref.get();
    if (!snap.exists || snap.get('token') !== token) return res.status(401).json({ error: 'Unknown device' });

    const th = { ...DEFAULTS, ...(snap.get('thresholds') || {}) };
    const alerts: string[] = [];
    if (temp > th.tempMax) alerts.push(`Too hot: ${temp.toFixed(1)}C. Open vents and give cool clean water.`);
    if (temp < th.tempMin) alerts.push(`Too cold: ${temp.toFixed(1)}C. Check brooder heat and draughts.`);
    if (hum > th.humMax) alerts.push(`Too humid: ${hum.toFixed(0)}%. Improve airflow and keep litter dry.`);
    if (hum < th.humMin) alerts.push(`Air too dry: ${hum.toFixed(0)}%. Watch for dust and respiratory trouble.`);
    if (gas !== null && gas > th.gasMax) alerts.push(`Bad air (gas reading ${Math.round(gas)}). Open vents and change wet litter.`);

    const now = Date.now();
    const update: Record<string, any> = {
      last: { temp, hum, gas, alerts, ts: Timestamp.now() },
    };

    if (now - (snap.get('lastStoredMs') || 0) >= 10 * 60 * 1000) {
      await ref.collection('readings').add({
        temp, hum, gas, alerts,
        ts: Timestamp.now(),
        expireAt: Timestamp.fromMillis(now + 30 * 86400000), // optional: enable a Firestore TTL policy on this field
      });
      update.lastStoredMs = now;
    }

    const phone = String(snap.get('alertPhone') || '').trim();
    if (alerts.length > 0 && phone && now - (snap.get('lastSmsMs') || 0) > 2 * 3600 * 1000) {
      try {
        await sendSms(phone.startsWith('+') ? phone : `+${phone}`, `Smart Kuku pod "${snap.get('name') || 'coop'}": ${alerts[0]}`);
        update.lastSmsMs = now;
      } catch (e) {
        console.error('sms failed', e);
      }
    }

    await ref.update(update);
    return res.status(200).json({ ok: true, alerts: alerts.length });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
}
