import { z } from 'zod';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export type Intent =
  | 'CHECK_STATUS'
  | 'BOOK'
  | 'RESCHEDULE'
  | 'CANCEL'
  | 'MY_TRIPS'
  | 'AGENT_HANDOFF'
  | 'MENU'
  | 'UNKNOWN';

export interface IntentResult {
  intent: Intent;
  confidence: number;
  slots: Record<string, any>;
  source?: 'llm' | 'keyword';
}

// Minimum confidence for an LLM result to be trusted over the keyword fallback.
const LLM_CONFIDENCE_THRESHOLD = 0.55;

// zod schema — the LLM output is validated against this before it is ever used.
const LlmIntentSchema = z.object({
  intent: z.enum(['CHECK_STATUS', 'BOOK', 'RESCHEDULE', 'CANCEL', 'MY_TRIPS', 'AGENT_HANDOFF', 'UNKNOWN']),
  confidence: z.number().min(0).max(1),
  slots: z
    .object({
      pnr: z.string().optional(),
      lastName: z.string().optional(),
      origin: z.string().optional(),
      destination: z.string().optional(),
      date: z.string().optional()
    })
    .partial()
    .default({})
});

const PNR_REGEX = /\b(BW\d{4})\b/i;

function extractPnr(message: string): string | undefined {
  const m = message.match(PNR_REGEX);
  return m ? m[1].toUpperCase() : undefined;
}

/**
 * Deterministic keyword router. Always available; used as the fallback whenever
 * the LLM is unavailable, times out, returns invalid JSON, or is low-confidence.
 */
export function keywordParseIntent(message: string): IntentResult {
  const normalized = message.toLowerCase().trim();
  const slots: Record<string, any> = {};
  const pnr = extractPnr(message);
  if (pnr) slots.pnr = pnr;

  let intent: Intent = 'UNKNOWN';

  // 1. Agent handoff
  if (
    normalized.includes('agent') ||
    normalized.includes('human') ||
    normalized.includes('support') ||
    normalized.includes('representative') ||
    normalized.includes('customer service') ||
    normalized.includes('talk to someone')
  ) {
    intent = 'AGENT_HANDOFF';
  }
  // 2. Cancel BEFORE book — "cancel my booking" contains the substring "book".
  //    ('radd' = Hinglish for cancel)
  else if (
    normalized.includes('cancel') ||
    normalized.includes('refund') ||
    normalized.includes('void') ||
    normalized.includes('radd')
  ) {
    intent = 'CANCEL';
  }
  // 3. Reschedule BEFORE book — "reschedule my booking" also contains "book".
  //    ('badal' = Hinglish for change)
  else if (
    normalized.includes('reschedule') ||
    normalized.includes('change') ||
    normalized.includes('modify') ||
    normalized.includes('postpone') ||
    normalized.includes('different flight') ||
    normalized.includes('badal')
  ) {
    intent = 'RESCHEDULE';
  }
  // 4. Check booking status ('kab'/'kahan' = Hinglish when/where)
  else if (
    normalized.includes('status') ||
    normalized.includes('details') ||
    normalized.includes('gate') ||
    normalized.includes('timing') ||
    normalized.includes('time') ||
    normalized.includes('where is my') ||
    /\bkab\b/.test(normalized) ||
    /\bkahan\b/.test(normalized)
  ) {
    intent = 'CHECK_STATUS';
  }
  // 5. My trips — after the action verbs (so "cancel my booking" stays CANCEL)
  // but before BOOK ("my bookings"/"my flights" contain BOOK keywords).
  else if (
    normalized.includes('my bookings') ||
    normalized.includes('my trips') ||
    normalized.includes('my flights') ||
    normalized.includes('list bookings') ||
    normalized.includes('show bookings') ||
    normalized.includes('all bookings')
  ) {
    intent = 'MY_TRIPS';
  }
  // 6. Book a flight (last, so more-specific action words win first)
  else if (
    normalized.includes('book') ||
    normalized.includes('reserve') ||
    normalized.includes('search') ||
    normalized.includes('flights') ||
    normalized.includes('new ticket')
  ) {
    intent = 'BOOK';
  }

  // One-message booking slots: "<origin> to <destination>" and a YYYY-MM-DD date.
  // Extraction is permissive — the controller validates against served routes and
  // silently drops anything that doesn't resolve to a real airport.
  if (intent === 'BOOK') {
    const dateMatch = message.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (dateMatch) slots.date = dateMatch[1];
    const routeMatch = normalized.match(/(?:from\s+)?([a-z]{3,})\s+to\s+([a-z]{3,})/);
    if (routeMatch) {
      slots.origin = routeMatch[1];
      slots.destination = routeMatch[2];
    }
  }

  return {
    intent,
    confidence: intent !== 'UNKNOWN' ? 1.0 : 0.0,
    slots,
    source: 'keyword'
  };
}

const SYSTEM_PROMPT = `You are the intent classifier for BlueWings Airlines' conversational booking assistant.
Classify the user's message into EXACTLY ONE intent and extract any slots you can find.

Intents:
- CHECK_STATUS: user wants the status / gate / timing / details of an existing booking.
- BOOK: user wants to book/search a NEW flight.
- RESCHEDULE: user wants to change/postpone an existing booking to a different flight/date.
- CANCEL: user wants to cancel an existing booking or asks about a refund.
- MY_TRIPS: user wants a list/overview of ALL their bookings or upcoming trips ("show my bookings", "what trips do I have").
- AGENT_HANDOFF: user EXPLICITLY asks for a human/agent/representative, or has a concrete request outside the flows above.
- UNKNOWN: the message is unclear, empty, or you cannot confidently classify it. Bare greetings ("hi", "hello"), thanks, or generic help requests with no specific ask ("help", "can you assist me?") are UNKNOWN — never AGENT_HANDOFF.

Slots to extract when present:
- pnr: a booking reference like BW9001 (format BW followed by 4 digits).
- lastName: a passenger last name.
- origin, destination: 3-letter airport codes (e.g., BOM, DEL, BLR).
- date: a travel date in YYYY-MM-DD format.

Users may write in Hindi or Hinglish (romanized Hindi) — classify these exactly the same way. Examples:
"meri flight cancel karni hai" / "ticket radd karo" = CANCEL; "flight badalni hai" / "flight aage karo" = RESCHEDULE;
"meri flight kab hai" / "flight kahan se hai" = CHECK_STATUS; "mujhe delhi jana hai" / "flight book karni hai" = BOOK.

Respond with ONLY a JSON object, no prose, of the form:
{"intent":"CHECK_STATUS","confidence":0.0-1.0,"slots":{"pnr":"...","lastName":"...","origin":"...","destination":"...","date":"..."}}
Omit slot keys you cannot fill. "confidence" reflects how sure you are of the intent.`;

/**
 * OPENROUTER_MODEL may be a single slug or a comma-separated fallback list.
 * OpenRouter expects `model` for one, `models` (max 3) for several.
 */
function buildModelParam(): { model: string } | { models: string[] } {
  const models = env.OPENROUTER_MODEL.split(',').map(m => m.trim()).filter(Boolean);
  return models.length > 1 ? { models: models.slice(0, 3) } : { model: models[0] };
}

/**
 * Calls OpenRouter (OpenAI-compatible chat completions) to classify intent.
 * Returns null on any failure so the caller can fall back to the keyword router.
 */
async function llmParseIntent(message: string): Promise<IntentResult | null> {
  if (!env.OPENROUTER_API_KEY) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.LLM_TIMEOUT_MS);

  try {
    const res = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': env.OPENROUTER_APP_URL,
        'X-Title': env.OPENROUTER_APP_TITLE
      },
      body: JSON.stringify({
        // Comma-separated OPENROUTER_MODEL becomes a fallback list (OpenRouter max: 3).
        // No response_format here — not all free models support it; the prompt demands
        // JSON and we extract + zod-validate the object from the content instead.
        ...buildModelParam(),
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: message }
        ]
      })
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(`OpenRouter non-200 (${res.status}); falling back to keyword router. ${body.slice(0, 200)}`);
      return null;
    }

    const data: any = await res.json();
    const content: string | undefined = data?.choices?.[0]?.message?.content;
    if (!content) {
      logger.warn('OpenRouter returned no content; falling back to keyword router.');
      return null;
    }

    // The model may wrap JSON in code fences or add stray text — extract the object.
    const jsonText = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
    const parsed = LlmIntentSchema.safeParse(JSON.parse(jsonText));
    if (!parsed.success) {
      logger.warn(`OpenRouter output failed zod validation; falling back. ${parsed.error.message.slice(0, 200)}`);
      return null;
    }

    const slots: Record<string, any> = { ...parsed.data.slots };
    // Backstop: always trust a regex-detected PNR over the model.
    const regexPnr = extractPnr(message);
    if (regexPnr) slots.pnr = regexPnr;
    if (slots.origin) slots.origin = String(slots.origin).toUpperCase();
    if (slots.destination) slots.destination = String(slots.destination).toUpperCase();

    return {
      intent: parsed.data.intent,
      confidence: parsed.data.confidence,
      slots,
      source: 'llm'
    };
  } catch (err: any) {
    const reason = err?.name === 'AbortError' ? 'timeout' : (err?.message || 'error');
    logger.warn(`OpenRouter call failed (${reason}); falling back to keyword router.`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Bare greetings and generic help requests show the menu — never the agent
 * queue and never a "failed parse". Anchored full-match, so a message with an
 * actual ask ("help me cancel my flight") still reaches the LLM/keyword router.
 */
const GREETING_HELP_REGEX =
  /^(hi+|hello+|hey+|yo|namaste|good\s*(morning|afternoon|evening)|(please\s*)?help(\s*me)?|i\s*need\s*help|can\s*you\s*help(\s*me)?|what\s*can\s*you\s*do|how\s*does\s*this\s*work|menu|start|get\s*started|options|thanks|thank\s*you)[\s!.?]*$/i;

/**
 * Public entrypoint. Tries the LLM first (if configured); falls back to the
 * deterministic keyword router on outage, timeout, invalid output, or low confidence.
 */
export async function parseIntent(message: string): Promise<IntentResult> {
  logger.info(`Parsing intent for message: "${message}"`);

  if (GREETING_HELP_REGEX.test(message.trim())) {
    logger.info('Intent via greeting/help pre-check: MENU');
    return { intent: 'MENU', confidence: 1.0, slots: {}, source: 'keyword' };
  }

  const llm = await llmParseIntent(message);
  if (llm && llm.intent !== 'UNKNOWN' && llm.confidence >= LLM_CONFIDENCE_THRESHOLD) {
    logger.info(`Intent via LLM: ${llm.intent} (confidence ${llm.confidence})`);
    return llm;
  }

  const keyword = keywordParseIntent(message);
  // If the LLM produced slots (e.g. a PNR) but was low-confidence/unknown, keep them.
  if (llm && Object.keys(llm.slots).length > 0) {
    keyword.slots = { ...llm.slots, ...keyword.slots };
  }
  logger.info(`Intent via keyword fallback: ${keyword.intent}`);
  return keyword;
}
