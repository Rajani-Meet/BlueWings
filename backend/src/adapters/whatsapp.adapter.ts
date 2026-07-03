import { Request, Response } from 'express';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { processIncomingMessage } from '../controllers/message.controller';

const GRAPH_API_BASE = 'https://graph.facebook.com/v20.0';

/** GET webhook verification handshake (Meta dashboard setup). */
export function verifyWhatsAppWebhook(req: Request, res: Response) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('WhatsApp webhook verified successfully.');
    res.status(200).send(challenge);
  } else {
    logger.warn('WhatsApp webhook verification failed.');
    res.sendStatus(403);
  }
}

interface InboundWhatsAppMessage {
  from: string; // sender phone number (E.164 without '+')
  text: string; // message body; '' for unsupported (non-text) message types
}

/**
 * Translate Meta's webhook envelope (entry[].changes[].value.messages[]) into
 * our internal shape. Ignores status/delivery-receipt events, which have no
 * `messages` array. Pure format translation — no business logic.
 */
function extractInboundMessages(body: any): InboundWhatsAppMessage[] {
  const out: InboundWhatsAppMessage[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const msg of change?.value?.messages ?? []) {
        if (!msg?.from) continue;
        if (msg.type === 'text' && msg.text?.body) {
          out.push({ from: msg.from, text: msg.text.body });
        } else if (msg.type === 'interactive') {
          // Button/list taps carry their title — feed it back as if typed.
          const title = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title;
          out.push({ from: msg.from, text: title || '' });
        } else {
          out.push({ from: msg.from, text: '' }); // unsupported type (image, audio, ...)
        }
      }
    }
  }
  return out;
}

// Meta limits: button titles 20 chars (max 3 buttons), list row titles 24 chars
// (max 10 rows), interactive body 1024 chars.
const WA_BUTTON_TITLE_MAX = 20;
const WA_INTERACTIVE_BODY_MAX = 1024;

/**
 * Build the Graph API message payload. Suggestions become native interactive
 * buttons (≤3) or a list message (4-10); anything unsupported falls back to
 * plain text so the reply always goes through.
 */
export function buildWhatsAppMessagePayload(toPhone: string, text: string, suggestions?: string[]): object {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: toPhone };
  const chips = (suggestions ?? []).filter(s => s.length > 0 && s.length <= WA_BUTTON_TITLE_MAX).slice(0, 10);

  if (chips.length === 0 || text.length > WA_INTERACTIVE_BODY_MAX) {
    return { ...base, type: 'text', text: { body: text } };
  }

  if (chips.length <= 3) {
    return {
      ...base,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text },
        action: {
          buttons: chips.map((title, i) => ({ type: 'reply', reply: { id: `chip_${i}`, title } }))
        }
      }
    };
  }

  return {
    ...base,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text },
      action: {
        button: 'Choose an option',
        sections: [{ title: 'BlueWings', rows: chips.map((title, i) => ({ id: `chip_${i}`, title })) }]
      }
    }
  };
}

/**
 * POST webhook: ack Meta immediately (it retries on slow/non-200 responses),
 * then translate each inbound message, hand it to the channel-agnostic core,
 * and send the reply back through the Cloud API.
 */
export async function handleWhatsAppWebhook(req: Request, res: Response) {
  res.sendStatus(200);

  try {
    const inbound = extractInboundMessages(req.body);
    for (const msg of inbound) {
      if (!msg.text) {
        await sendWhatsAppMessage(
          msg.from,
          "Sorry, I can only read text messages right now. Please type your request — for example 'check my booking status'."
        );
        continue;
      }
      const result = await processIncomingMessage({
        channel: 'WHATSAPP',
        userId: msg.from,
        message: msg.text
      });
      await sendWhatsAppMessage(msg.from, result.reply, result.suggestions);
    }
  } catch (error: any) {
    // Already acked; just log. processIncomingMessage itself never throws.
    logger.error('WhatsApp webhook handler error', error);
  }
}

/**
 * Send a text message via the WhatsApp Cloud API. When credentials are absent
 * (local dev), logs the outbound message instead so flows remain testable.
 */
export async function sendWhatsAppMessage(toPhone: string, text: string, suggestions?: string[]): Promise<boolean> {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    logger.info(`[WA SIMULATED -> ${toPhone}] ${text}`);
    return false;
  }

  try {
    const res = await fetch(`${GRAPH_API_BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(buildWhatsAppMessagePayload(toPhone, text, suggestions))
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error(`WhatsApp send failed (${res.status}): ${body.slice(0, 300)}`);
      return false;
    }
    logger.info(`WhatsApp message sent to ${toPhone}`);
    return true;
  } catch (error: any) {
    logger.error('WhatsApp send error', error);
    return false;
  }
}
