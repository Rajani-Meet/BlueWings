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
        } else {
          out.push({ from: msg.from, text: '' }); // unsupported type (image, audio, ...)
        }
      }
    }
  }
  return out;
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
      await sendWhatsAppMessage(msg.from, result.reply);
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
export async function sendWhatsAppMessage(toPhone: string, text: string): Promise<boolean> {
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
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toPhone,
        type: 'text',
        text: { body: text }
      })
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
