import prisma from '../db/prismaClient';
import { logger } from '../utils/logger';

export interface SessionState {
  currentFlow: 'CHECK_STATUS' | 'BOOK' | 'RESCHEDULE' | 'CANCEL' | 'TRIPS' | null;
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
  /** Proactive notice (e.g. flight delay) prepended to the next bot reply. */
  pendingNotice?: string;
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
  },

  /**
   * Atomically read-and-clear a session's pending notice (if any). Runs before
   * the message is processed so the notice rides on top of the next reply.
   */
  async consumePendingNotice(channel: 'PWA' | 'WHATSAPP', channelUserId: string): Promise<string | null> {
    try {
      const session = await prisma.conversationSession.findUnique({
        where: { channel_channelUserId: { channel, channelUserId } }
      });
      if (!session) return null;
      const state: SessionState = JSON.parse(session.stateJson);
      if (!state.pendingNotice) return null;
      const notice = state.pendingNotice;
      delete state.pendingNotice;
      await prisma.conversationSession.update({
        where: { id: session.id },
        data: { stateJson: JSON.stringify(state) }
      });
      return notice;
    } catch (error) {
      logger.error('Error in consumePendingNotice', error);
      return null; // a notice must never break message handling
    }
  },

  /**
   * Attach a proactive notice to every session that has interacted with this
   * PNR (verified it, or currently has it in a flow). Used by ops events like
   * flight delays so the user's next chat turn — on any channel — surfaces it.
   */
  async addPendingNoticeByPnr(pnr: string, notice: string): Promise<number> {
    try {
      const target = pnr.toUpperCase();
      const sessions = await prisma.conversationSession.findMany({
        where: { stateJson: { contains: target } }
      });
      let updated = 0;
      for (const session of sessions) {
        const state: SessionState = JSON.parse(session.stateJson);
        if (state.auth?.pnr === target || state.slots?.pnr === target) {
          state.pendingNotice = notice;
          await prisma.conversationSession.update({
            where: { id: session.id },
            data: { stateJson: JSON.stringify(state) }
          });
          updated++;
        }
      }
      return updated;
    } catch (error) {
      logger.error('Error in addPendingNoticeByPnr', error);
      return 0;
    }
  }
};
