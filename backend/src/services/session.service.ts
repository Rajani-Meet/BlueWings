import prisma from '../db/prismaClient';
import { logger } from '../utils/logger';

export interface SessionState {
  currentFlow: 'CHECK_STATUS' | 'BOOK' | 'RESCHEDULE' | 'CANCEL' | null;
  step: number;
  slots: {
    pnr?: string;
    lastName?: string;
    origin?: string;
    destination?: string;
    date?: string;
    selectedFlightId?: string;
    newFlightId?: string;
    [key: string]: any;
  };
  auth: {
    pnr?: string;
    lastName?: string;
    verified: boolean;
  };
  consecutiveFailedParses: number;
}

const DEFAULT_STATE: SessionState = {
  currentFlow: null,
  step: 0,
  slots: {},
  auth: { verified: false },
  consecutiveFailedParses: 0
};

export const sessionService = {
  async getOrCreateSession(channel: 'PWA' | 'WHATSAPP', channelUserId: string) {
    try {
      let session = await prisma.conversationSession.findUnique({
        where: {
          channel_channelUserId: { channel, channelUserId }
        }
      });

      if (!session) {
        session = await prisma.conversationSession.create({
          data: {
            channel,
            channelUserId,
            stateJson: JSON.stringify(DEFAULT_STATE),
            agentHandoffActive: false
          }
        });
      }

      // Merge over defaults so sessions persisted before a state-shape change
      // (e.g. missing `auth`) still deserialize into a complete SessionState.
      const state: SessionState = { ...DEFAULT_STATE, ...JSON.parse(session.stateJson) };
      return {
        id: session.id,
        channel: session.channel as 'PWA' | 'WHATSAPP',
        channelUserId: session.channelUserId,
        state,
        agentHandoffActive: session.agentHandoffActive
      };
    } catch (error) {
      logger.error('Error in getOrCreateSession', error);
      throw error;
    }
  },

  async updateSessionState(id: string, state: SessionState) {
    try {
      await prisma.conversationSession.update({
        where: { id },
        data: {
          stateJson: JSON.stringify(state)
        }
      });
    } catch (error) {
      logger.error('Error in updateSessionState', error);
      throw error;
    }
  },

  async clearSessionState(id: string) {
    try {
      await prisma.conversationSession.update({
        where: { id },
        data: {
          stateJson: JSON.stringify(DEFAULT_STATE),
          agentHandoffActive: false
        }
      });
    } catch (error) {
      logger.error('Error in clearSessionState', error);
      throw error;
    }
  },

  async setAgentHandoff(id: string, active: boolean) {
    try {
      await prisma.conversationSession.update({
        where: { id },
        data: {
          agentHandoffActive: active
        }
      });
    } catch (error) {
      logger.error('Error in setAgentHandoff', error);
      throw error;
    }
  }
};
