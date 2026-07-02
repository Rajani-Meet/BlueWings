import prisma from '../db/prismaClient';
import { logger } from '../utils/logger';

export const agentHandoffService = {
  async triggerHandoff(sessionId: string): Promise<boolean> {
    logger.warn(`Agent handoff triggered for session ID: ${sessionId}`);
    
    await prisma.conversationSession.update({
      where: { id: sessionId },
      data: { agentHandoffActive: true }
    });
    
    return true;
  }
};
