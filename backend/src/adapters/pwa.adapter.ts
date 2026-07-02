import { logger } from '../utils/logger';

export function translatePWAPayload(body: any) {
  logger.info('Translating PWA payload:', JSON.stringify(body));
  return {
    channel: 'PWA' as const,
    userId: body.userId,
    message: body.message
  };
}
