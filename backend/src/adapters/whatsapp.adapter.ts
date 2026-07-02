import { Request, Response } from 'express';
import { env } from '../config/env';
import { logger } from '../utils/logger';

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

export async function handleWhatsAppWebhook(req: Request, res: Response) {
  try {
    // Simply print and return status for stub purposes in Step 1
    logger.info('WhatsApp Webhook Payload (stub):', JSON.stringify(req.body));
    res.status(200).json({ status: 'received' });
  } catch (error: any) {
    logger.error('WhatsApp Webhook Handler Error', error);
    res.status(500).json({ error: error.message });
  }
}

export async function sendWhatsAppMessage(toPhone: string, text: string) {
  // Placeholder for sending messages to WhatsApp Cloud API
  logger.info(`Simulating sending WhatsApp message to ${toPhone}: "${text}"`);
  return true;
}
