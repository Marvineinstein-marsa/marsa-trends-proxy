import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const TAVILY_API_URL = 'https://api.tavily.com/search';

const ALLOWED_ORIGINS = [
  'https://studio-wheat-tau.vercel.app',
  'https://studio-git-main-marvineinstein-marsas-projects.vercel.app',
];

type Category = 'treatments' | 'innovations' | 'crops' | 'outbreaks' | 'prices';

const searchQueries: Record<Category, string> = {
  treatments: 'latest poultry disease treatments Uganda 2026 medicine prices',
  innovations: 'innovative farming technology techniques Uganda 2026',
  crops: 'maize tomato bean yield tips Uganda 2026',
  outbreaks: 'Newcastle disease foot and mouth swine fever outbreak Uganda East Africa',
  prices: 'egg chicken maize prices Uganda today market',
};

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

const systemInstruction = `You are Dr. MARSA Trends AI. Your goal is to provide Ugandan farmers with the most current, actionable farming data based on the search results provided to you.
Structure your response using Markdown with clear headings and bullet points.
If you find price data, format it as a simple table.
If you find an outbreak, start with a "⚠️ ALERT" header.
Base your answer only on the search results given. If the results don't cover something, say so briefly rather than guessing.`;

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
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  return fetch(url, options);
}

async function getTavilyContext(category: Category, tavilyKey: string): Promise<string> {
  const res = await fetch(TAVILY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: tavilyKey,
      query: searchQueries[category],
      search_depth: 'basic',
      max_results: 5,
      include_answer: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Tavily API error ${res.status}:`, body);
    return ''; // fall back to empty context rather than failing the whole request
  }

  const data = await res.json();
  const results = data?.results || [];

  return results
    .map((r: any, i: number) => `Source ${i + 1} (${r.url}): ${r.title}\n${r.content}`)
    .join('\n\n');
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

    const groqKey = process.env.GROQ_API_KEY;
    const tavilyKey = process.env.TAVILY_API_KEY;

    if (!groqKey || !tavilyKey) {
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500, headers });
    }

    const searchContext = await getTavilyContext(category as Category, tavilyKey);

    const userPrompt = searchContext
      ? `${prompts[category as Category]}\n\nHere are current search results to base your answer on:\n\n${searchContext}`
      : prompts[category as Category];

    const response = await fetchWithRetry(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userPrompt },
        ],
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
