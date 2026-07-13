import { NextRequest, NextResponse } from 'next/server';

const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';
const ALLOWED_ORIGINS = [
  'https://studio-wheat-tau.vercel.app',
  'https://studio-git-main-marvineinstein-marsas-projects.vercel.app',
];

type Category = 'treatments' | 'innovations' | 'crops' | 'outbreaks' | 'prices';

const prompts: Record<Category, string> = {
  treatments: `What are the latest poultry disease treatments in 2026 for East Africa, especially Uganda? Include medicine names, what they treat, where to buy in Uganda, and price ranges.`,
  innovations: `What are the most innovative farming techniques for high yield crops in 2026? Focus on methods applicable to the Ugandan climate.`,
  crops: `What are the best ways to increase maize, tomato, and bean yield in Uganda in 2026? Provide specific, actionable production tips.`,
  outbreaks: `Are there any animal disease outbreaks in East Africa in 2026? Check for Newcastle disease, Foot and Mouth, or Swine Fever alerts in Uganda.`,
  prices: `What are the current prices for eggs, chicken, and maize in Uganda in 2026? Provide a market trend summary.`,
};

const systemInstruction = `You are Dr. MARSA Trends AI. Your goal is to provide Ugandan farmers with the most current, actionable farming data.
Structure your response using Markdown with clear headings and bullet points.
If you find price data, format it as a simple table.
If you find an outbreak, start with a "⚠️ ALERT" header.`;

function corsHeaders(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) });
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');
  const headers = corsHeaders(origin);

  try {
    const { category } = await req.json();

    if (!category || !prompts[category as Category]) {
      return NextResponse.json({ error: 'Invalid category' }, { status: 400, headers });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500, headers });
    }

    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: [{ parts: [{ text: prompts[category as Category] }] }],
        tools: [{ google_search: {} }],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Gemini API error ${response.status}:`, errorBody);
      return NextResponse.json({ error: `Gemini error: ${response.status}` }, { status: 502, headers });
    }

    const data = await response.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!content) {
      return NextResponse.json({ error: 'Empty response from Gemini' }, { status: 502, headers });
    }

    return NextResponse.json(
      { content, category, timestamp: new Date().toLocaleTimeString() },
      { headers }
    );
  } catch (e) {
    console.error('Proxy error:', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500, headers });
  }
}
