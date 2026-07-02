import { logger } from '../utils/logger';

export interface IntentResult {
  intent: 'CHECK_STATUS' | 'BOOK' | 'RESCHEDULE' | 'CANCEL' | 'AGENT_HANDOFF' | 'UNKNOWN';
  confidence: number;
  slots: Record<string, any>;
}

export async function parseIntent(message: string): Promise<IntentResult> {
  const normalized = message.toLowerCase().trim();
  logger.info(`Parsing intent via Keyword Router for message: "${message}"`);

  // Detect PNR patterns (e.g. BW9001 or BW101)
  const pnrMatch = message.match(/\b(BW\d{4})\b/i);
  const pnr = pnrMatch ? pnrMatch[1].toUpperCase() : undefined;

  let intent: 'CHECK_STATUS' | 'BOOK' | 'RESCHEDULE' | 'CANCEL' | 'AGENT_HANDOFF' | 'UNKNOWN' = 'UNKNOWN';
  const slots: Record<string, any> = {};

  if (pnr) {
    slots.pnr = pnr;
  }

  // 1. Check Agent Handoff keywords
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
  // 2. Check Cancel keywords BEFORE Book — "cancel my booking" contains the substring "book".
  else if (
    normalized.includes('cancel') ||
    normalized.includes('refund') ||
    normalized.includes('void')
  ) {
    intent = 'CANCEL';
  }
  // 3. Check Reschedule keywords BEFORE Book — "reschedule my booking" also contains "book".
  else if (
    normalized.includes('reschedule') ||
    normalized.includes('change') ||
    normalized.includes('modify') ||
    normalized.includes('postpone') ||
    normalized.includes('different flight')
  ) {
    intent = 'RESCHEDULE';
  }
  // 4. Check Booking Status keywords
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
  // 5. Check Book Flight keywords (last, so more-specific action words win first)
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
    slots
  };
}
