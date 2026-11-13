// Smart Kuku - Phase 4: USSD menu for feature phones (Africa's Talking)

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

// Uganda is UTC+3
const todayKampala = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const shiftDays = (iso: string, d: number) => {
  const x = new Date(iso + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
};
const diffDays = (a: string, b: string) =>
  Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

// Chick vaccine guide (Marek's is done at the hatchery). Farmers are told to confirm with a vet.
const VACC = [
  { name: 'Newcastle (Lasota) eye drop', day: 7 },
  { name: 'Gumboro 1st dose', day: 14 },
  { name: 'Gumboro booster', day: 21 },
  { name: 'Newcastle booster', day: 28 },
  { name: 'Fowl pox wing web', day: 42 },
];

const posInt = (s?: string) => {
  const v = Number((s || '').trim());
  return Number.isInteger(v) && v > 0 && v <= 100000 ? v : 0;
};

export default async function handler(req: any, res: any) {
  const send = (m: string) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(m);
  };

  if (req.method !== 'POST') return res.status(405).send('Use POST');
  if (!process.env.USSD_KEY || req.query?.key !== process.env.USSD_KEY) return res.status(401).send('Unauthorized');

  let body = req.body;
  if (typeof body === 'string') body = Object.fromEntries(new URLSearchParams(body));
  const phone = String(body?.phoneNumber || '').trim();
  const text = String(body?.text || '');
  if (!/^\+?\d{9,15}$/.test(phone)) return send('END Invalid phone number.');

  try {
    const db = getDb();
    const ref = db.collection('ussd_farmers').doc(phone);
    const snap = await ref.get();
    const parts = text === '' ? [] : text.split('*');
    const today = todayKampala();

    /* ---------- First time: register ---------- */
    if (!snap.exists) {
      if (parts.length === 0) return send('CON Welcome to Smart Kuku.\nHow many chickens do you have?\n(Enter a number)');
      const birds = posInt(parts[0]);
      if (!birds) return send('END Please dial again and enter a number like 50.');
      if (parts.length === 1) return send('CON How old are your birds in days?\n(Enter 0 if not sure)');
      const age = Number(parts[1]);
      if (!Number.isInteger(age) || age < 0 || age > 3650) return send('END Please dial again and enter the age in days, like 14.');
      await ref.set({
        phone, birds, deaths: 0,
        startDate: age > 0 ? shiftDays(today, -age) : '',
        smsReminders: true,
        createdAt: FieldValue.serverTimestamp(),
      });
      return send(`END Saved: ${birds} birds. Dial again to log eggs, deaths and get help.`);
    }

    const farmer = snap.data() as any;
    const logs = ref.collection('logs');

    /* ---------- Main menu ---------- */
    if (parts.length === 0) {
      return send('CON Smart Kuku\n1 Log eggs\n2 Log deaths\n3 My flock summary\n4 Vaccines due\n5 Sick bird help\n6 Egg prices\n7 SMS reminders on/off');
    }

    switch (parts[0]) {
      case '1': {
        if (parts.length === 1) return send('CON How many eggs today?');
        const q = posInt(parts[1]);
        if (!q) return send('END Please enter a number like 25.');
        await logs.add({ type: 'eggs', qty: q, date: today, ts: FieldValue.serverTimestamp() });
        const week = await logs.where('date', '>=', shiftDays(today, -6)).get();
        const eggs7 = week.docs.reduce((s, d) => s + (d.get('type') === 'eggs' ? Number(d.get('qty')) || 0 : 0), 0);
        return send(`END Saved ${q} eggs. Last 7 days: ${eggs7} eggs.`);
      }

      case '2': {
        if (parts.length === 1) return send('CON How many birds died today?');
        const q = posInt(parts[1]);
        if (!q) return send('END Please enter a number like 2.');
        await logs.add({ type: 'mortality', qty: q, date: today, ts: FieldValue.serverTimestamp() });
        await ref.update({ deaths: FieldValue.increment(q) });
        const alive = Math.max(0, (farmer.birds || 0) - (farmer.deaths || 0) - q);
        if (q >= 3) {
          return send(`END Saved ${q} deaths. Birds left: ${alive}. Several deaths in a day: separate sick birds and call your vet or District Veterinary Officer.`);
        }
        return send(`END Saved ${q} deaths. Birds left: ${alive}.`);
      }

      case '3': {
        const week = await logs.where('date', '>=', shiftDays(today, -6)).get();
        const eggs7 = week.docs.reduce((s, d) => s + (d.get('type') === 'eggs' ? Number(d.get('qty')) || 0 : 0), 0);
        const alive = Math.max(0, (farmer.birds || 0) - (farmer.deaths || 0));
        return send(`END Birds alive: ${alive} of ${farmer.birds}\nDeaths: ${farmer.deaths || 0}\nEggs last 7 days: ${eggs7}`);
      }

      case '4': {
        if (!farmer.startDate) return send('END Bird age was not saved, so there is no chick vaccine schedule. Ask your vet.');
        const age = diffDays(farmer.startDate, today);
        if (age > 60) return send('END Your birds are past the chick vaccine schedule. Ask your vet about boosters.');
        const due = VACC.filter((v) => v.day - age <= 7 && v.day - age >= -2);
        if (due.length === 0) return send('END No vaccines due in the next 7 days. Confirm the plan with your vet.');
        const lines = due.map((v) => {
          const d = v.day - age;
          return `${v.name}: ${d < 0 ? `was due ${-d} days ago` : d === 0 ? 'TODAY' : `in ${d} days`}`;
        });
        return send(`END ${lines.join('\n')}\nConfirm timing with your vet.`);
      }

      case '5': {
        if (parts.length === 1) {
          return send('CON What do you see?\n1 Green watery droppings\n2 Bloody droppings\n3 Twisted neck or gasping\n4 Many sudden deaths');
        }
        const msgs: Record<string, string> = {
          '1': 'END Possible Newcastle disease. Separate sick birds, do not sell or move birds, and call your vet or District Veterinary Officer today.',
          '2': 'END Possible coccidiosis. Keep litter dry and clean, give clean water, and ask an agrovet for coccidiosis treatment today.',
          '3': 'END Possible Newcastle disease. Separate sick birds, wash hands and boots after handling, and call your District Veterinary Officer.',
          '4': 'END Many sudden deaths can mean a notifiable disease. Do not move birds or eggs off the farm and call your District Veterinary Officer now.',
        };
        return send(msgs[parts[1]] || 'END Invalid choice.');
      }

      case '6': {
        if (parts.length === 1) return send('CON Egg tray price (30 eggs)\n1 See price\n2 Report price');
        if (parts[1] === '1') {
          const since = Timestamp.fromMillis(Date.now() - 7 * 86400000);
          const q = await db.collection('ussd_prices').where('ts', '>=', since).orderBy('ts', 'desc').limit(20).get();
          if (q.empty) return send('END No egg prices reported this week yet. Be the first: choose 2 to report.');
          const prices = q.docs.map((d) => Number(d.get('price')) || 0).filter(Boolean);
          const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
          return send(`END Average tray price this week: UGX ${avg.toLocaleString('en-UG')} (${prices.length} reports).`);
        }
        if (parts[1] === '2') {
          if (parts.length === 2) return send('CON Price of one tray of 30 eggs in UGX?');
          const p = posInt(parts[2]);
          if (p < 2000 || p > 60000) return send('END Please enter the price for one tray, like 12000.');
          await db.collection('ussd_prices').add({ item: 'egg tray', price: p, ts: FieldValue.serverTimestamp() });
          return send('END Thank you. Your price was added.');
        }
        return send('END Invalid choice.');
      }

      case '7': {
        const on = farmer.smsReminders !== false;
        await ref.update({ smsReminders: !on });
        return send(on ? 'END SMS reminders are now OFF.' : 'END SMS reminders are now ON.');
      }

      default:
        return send('END Invalid choice. Dial again.');
    }
  } catch (e) {
    console.error('ussd error', e);
    return send('END Sorry, something went wrong. Try again later.');
  }
}
