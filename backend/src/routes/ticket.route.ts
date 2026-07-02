import { Router, Request, Response } from 'express';
import prisma from '../db/prismaClient';
import { lastNameMatches } from '../services/booking.service';
import { buildTicketData, renderTicketPdf } from '../services/ticket.service';
import { logger } from '../utils/logger';

const router = Router();

/**
 * GET /api/ticket/:pnr?lastName=Doe
 * Streams the e-ticket PDF. Same auth rule as the chat flows: the provided
 * last name must match the passenger on the booking.
 */
router.get('/:pnr', async (req: Request, res: Response) => {
  try {
    const pnr = String(req.params.pnr || '').toUpperCase();
    const lastName = String(req.query.lastName || '').trim();

    if (!/^BW\d{4}$/.test(pnr)) {
      return res.status(400).json({ error: 'Invalid PNR format' });
    }

    const booking = await prisma.booking.findUnique({
      where: { pnr },
      include: { passenger: true, flight: true }
    });

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    if (!lastName || !lastNameMatches(booking.passenger.name, lastName)) {
      return res.status(403).json({ error: 'Passenger last name does not match this booking' });
    }

    const pdf = await renderTicketPdf(buildTicketData(booking));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="BlueWings-E-Ticket-${pnr}.pdf"`);
    res.send(pdf);
  } catch (error: any) {
    logger.error('Error generating e-ticket PDF', error);
    res.status(500).json({ error: 'Could not generate the e-ticket right now' });
  }
});

export default router;
