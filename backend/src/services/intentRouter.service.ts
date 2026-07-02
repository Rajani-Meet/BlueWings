import { z } from 'zod';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export type Intent =
  | 'CHECK_STATUS'
  | 'BOOK'
  | 'RESCHEDULE'
  | 'CANCEL'
  | 'AGENT_HANDOFF'
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
  intent: z.enum(['CHECK_STATUS', 'BOOK', 'RESCHEDULE', 'CANCEL', 'AGENT_HANDOFF', 'UNKNOWN']),
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
  else if (
    normalized.includes('cancel') ||
    normalized.includes('refund') ||
    normalized.includes('void')
  ) {
    intent = 'CANCEL';
  }
  // 3. Reschedule BEFORE book — "reschedule my booking" also contains "book".
  else if (
    normalized.includes('reschedule') ||
    normalized.includes('change') ||
    normalized.includes('modify') ||
    normalized.includes('postpone') ||
    normalized.includes('different flight')
  ) {
    intent = 'RESCHEDULE';
  }
  // 4. Check booking status
  else if (
    normalized.includes('status') ||
    normalized.includes('details') ||
    normalized.includes('gate') ||
    normalized.includes('timing') ||
    normalized.includes('time') ||
    normalized.includes('where is my')
  ) {
    intent = 'CHECK_STATUS';
  }
  // 5. Book a flight (last, so more-specific action words win first)
  else if (
    normalized.includes('book') ||
    normalized.includes('reserve') ||
    normalized.includes('search') ||
    normalized.includes('flights') ||
    normalized.includes('new ticket')
  ) {
    intent = 'BOOK';
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
- AGENT_HANDOFF: user asks for a human/agent/representative, or the request is outside the four flows above.
- UNKNOWN: the message is unclear, empty, or you cannot confidently classify it.

Slots to extract when present:
- pnr: a booking reference like BW9001 (format BW followed by 4 digits).
- lastName: a passenger last name.
- origin, destination: 3-letter airport codes (e.g., BOM, DEL, BLR).
- date: a travel date in YYYY-MM-DD format.

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
 * Public entrypoint. Tries the LLM first (if configured); falls back to the
 * deterministic keyword router on outage, timeout, invalid output, or low confidence.
 */
export async function parseIntent(message: string): Promise<IntentResult> {
  logger.info(`Parsing intent for message: "${message}"`);

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
