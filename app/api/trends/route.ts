import { NextRequest, NextResponse } from 'next/server';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const ALLOWED_ORIGINS = [
  'https://studio-wheat-tau.vercel.app',
  'https://studio-git-main-marvineinstein-marsas-projects.vercel.app',
];

type Category = 'treatments' | 'innovations' | 'crops' | 'outbreaks' | 'prices';

const prompts: Record<Category, string> = {
  treatments: `What are the latest poultry disease treatments in 2026 for East Africa, especially Uganda? Include medicine names, what they treat, where to buy in Uganda, and price ranges.`,
  innovations: `What are the most innovative farming techniques for high yield crops in 2026? Focus on methods applicable to the Ugandan climate.`,
  crops: `What are the best ways to increase maize, tomato, and bean yield in Uganda in 2026? Provide specific, actionable production tips.`,
  outbreaks: `Are there any animal disease outbreaks in East Africa right now? Search for current Newcastle disease, Foot and Mouth, or Swine Fever alerts in Uganda.`,
  prices: `What are the current prices for eggs, chicken, and maize in Uganda today? Search for the latest market data and provide a summary.`,
};

const imagePrompts: Record<Category, string> = {
  treatments: 'poultry veterinary medicine treatment bottles, farm clinic, realistic photo',
  innovations: 'modern smart farming technology, drone over crops, greenhouse, realistic photo',
  crops: 'healthy maize and tomato farm field in Uganda, lush green crops, realistic photo',
  outbreaks: 'veterinarian examining sick chicken, disease alert, farm biosecurity, realistic photo',
  prices: 'African market stall with eggs chicken and maize, vendors, realistic photo',
};

function getImageUrl(category: Category): string {
  const prompt = encodeURIComponent(imagePrompts[category]);
  return `https://image.pollinations.ai/prompt/${prompt}?width=800&height=450&nologo=true`;
}

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

async function fetchWithRetry(url: string, options: RequestInit, retries = 2): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    await new Promise((r) => setTimeout(r, 1000 * (i + 1))); // wait 1s, then 2s
  }
  return fetch(url, options); // final attempt, return whatever happens
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

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500, headers });
    }

    const response = await fetchWithRetry(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'groq/compound',
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: prompts[category as Category] },
        ],
        search_settings: { max_results: 3 },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Groq API error ${response.status}:`, errorBody);
      return NextResponse.json({ error: `Groq error: ${response.status}` }, { status: 502, headers });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';

    if (!content) {
      return NextResponse.json({ error: 'Empty response from Groq' }, { status: 502, headers });
    }

    return NextResponse.json(
      {
        content,
        category,
        imageUrl: getImageUrl(category as Category),
        timestamp: new Date().toLocaleTimeString(),
      },
      { headers }
    );
  } catch (e) {
    console.error('Proxy error:', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500, headers });
  }
    }
