import { Router, Request, Response } from 'express';
import { bookingService } from '../services/booking.service';
import { sessionService } from '../services/session.service';
import { sendWhatsAppMessage } from '../adapters/whatsapp.adapter';
import { logger } from '../utils/logger';

const router = Router();

/**
 * POST /api/ops/simulate-delay/:pnr   body: { "minutes": 90 }
 *
 * Demo/ops tool (no auth — MVP): delays the flight behind the given PNR and
 * proactively notifies every affected passenger:
 *  - WhatsApp: immediate push via the Cloud API
 *  - Any channel: a pending notice that rides on top of their next bot reply
 */
router.post('/simulate-delay/:pnr', async (req: Request, res: Response) => {
  try {
    const pnr = String(req.params.pnr || '').toUpperCase();
    if (!/^BW\d{4}$/.test(pnr)) {
      return res.status(400).json({ error: 'Invalid PNR format' });
    }
    const minutes = Math.max(5, Math.min(24 * 60, Number(req.body?.minutes) || 90));

    const { flight, affected } = await bookingService.delayFlightByPnr(pnr, minutes);

    const newDep = flight.departureTime.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
    });
    const notice =
      `⚠️ *Flight Update*\n\n` +
      `Flight *${flight.flightNumber}* (${flight.origin} ➔ ${flight.destination}) is delayed by *${minutes} minutes*.\n` +
      `• *New departure*: ${newDep}\n\n` +
      `We're sorry for the inconvenience. No action is needed — your booking is unaffected.`;

    let whatsappPushes = 0;
    let sessionNotices = 0;
    for (const booking of affected) {
      // WhatsApp proactive push (phone stored E.164; Graph API wants digits only)
      const sent = await sendWhatsAppMessage(booking.passenger.phone.replace(/\D/g, ''), notice);
      if (sent) whatsappPushes++;
      // Surface on the next chat turn for sessions tied to this PNR (any channel)
      sessionNotices += await sessionService.addPendingNoticeByPnr(booking.pnr, notice);
    }

    logger.warn(`Simulated delay: ${flight.flightNumber} +${minutes}min — ${affected.length} bookings affected`);
    res.json({
      flight: flight.flightNumber,
      delayedByMinutes: minutes,
      newDeparture: flight.departureTime,
      affectedBookings: affected.map(b => b.pnr),
      whatsappPushes,
      sessionNotices
    });
  } catch (error: any) {
    if (error.message === 'Booking not found') {
      return res.status(404).json({ error: 'Booking not found' });
    }
    logger.error('Error simulating delay', error);
    res.status(500).json({ error: 'Could not simulate the delay' });
  }
});

export default router;
