import { bookingService } from './booking.service';

export const authService = {
  async authenticateUser(pnr: string, lastName: string): Promise<boolean> {
    const result = await bookingService.checkBookingStatus(pnr, lastName);
    if (!result || result.matchError) {
      return false;
    }
    return true;
  }
};
