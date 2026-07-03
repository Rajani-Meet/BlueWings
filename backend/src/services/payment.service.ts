import { logger } from '../utils/logger';

export interface PaymentResult {
  success: boolean;
  transactionId?: string;
  failureReason?: string;
}

export const paymentService = {
  /**
   * Simulated payment (no real gateway, per the brief). Deterministic failure
   * hook for demos and tests: pass `simulateFailure` (the controller sets it
   * for phone numbers ending in 0000) to exercise the declined-payment path.
   */
  async processPayment(amount: number, opts?: { simulateFailure?: boolean }): Promise<PaymentResult> {
    if (opts?.simulateFailure) {
      logger.warn(`Simulated payment of Rs. ${amount} DECLINED (failure trigger)`);
      return {
        success: false,
        failureReason: 'The payment was declined by the bank (simulated).'
      };
    }
    logger.info(`Processing simulated payment of Rs. ${amount}`);
    return {
      success: true,
      transactionId: `TXN-${Math.random().toString(36).substring(2, 11).toUpperCase()}`
    };
  }
};
