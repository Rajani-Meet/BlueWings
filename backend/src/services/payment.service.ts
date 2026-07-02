import { logger } from '../utils/logger';

export const paymentService = {
  async processPayment(amount: number): Promise<{ success: boolean; transactionId: string }> {
    logger.info(`Processing simulated payment of Rs. ${amount} (stub)`);
    return {
      success: true,
      transactionId: `TXN-${Math.random().toString(36).substring(2, 11).toUpperCase()}`
    };
  }
};
