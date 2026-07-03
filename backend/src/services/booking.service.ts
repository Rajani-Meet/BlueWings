import prisma from '../db/prismaClient';
import { logger } from '../utils/logger';
import { BookingStatus } from '@prisma/client';

// Discriminated union so callers can narrow on `matchError` and safely access `booking`.
export interface BookingStatusView {
  pnr: string;
  passengerName: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureTime: Date;
  arrivalTime: Date;
  status: BookingStatus;
  gate: string;
}
export type CheckBookingStatusResult =
  | null
  | { matchError: true }
  | { matchError: false; booking: BookingStatusView };

/** Case-insensitive last-name check against the passenger's full name. */
export function lastNameMatches(passengerName: string, lastName: string): boolean {
  const parts = passengerName.toLowerCase().split(/\s+/);
  const provided = lastName.toLowerCase().trim();
  return parts.includes(provided) || passengerName.toLowerCase().endsWith(provided);
}

/** Deterministic simulated gate, stable per PNR (mock flights carry no gate data). */
export function assignGate(pnr: string): string {
  const pnrSum = pnr.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const gates = ['Gate A12', 'Gate B4', 'Gate C18', 'Gate D9', 'Gate G24'];
  return gates[pnrSum % gates.length];
}

/** Deterministic simulated seat, stable per PNR (mock bookings carry no seat data). */
export function assignSeat(pnr: string): string {
  const pnrSum = pnr.split('').reduce((sum, char) => sum + char.charCodeAt(0) * 7, 0);
  const row = (pnrSum % 28) + 2; // rows 2-29
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  return `${row}${letters[pnrSum % letters.length]}`;
}

export const bookingService = {
  async checkBookingStatus(pnr: string, lastName: string): Promise<CheckBookingStatusResult> {
    logger.info(`Fetching booking details for PNR: ${pnr}, checking last name: ${lastName}`);
    
    const booking = await prisma.booking.findUnique({
      where: { pnr: pnr.toUpperCase() },
      include: {
        passenger: true,
        flight: true
      }
    });

    if (!booking) {
      return null;
    }

    if (!lastNameMatches(booking.passenger.name, lastName)) {
      return { matchError: true };
    }

    const assignedGate = assignGate(pnr);

    return {
      matchError: false,
      booking: {
        pnr: booking.pnr,
        passengerName: booking.passenger.name,
        flightNumber: booking.flight.flightNumber,
        origin: booking.flight.origin,
        destination: booking.flight.destination,
        departureTime: booking.flight.departureTime,
        arrivalTime: booking.flight.arrivalTime,
        status: booking.status,
        gate: assignedGate
      }
    };
  },

  /** Distinct airports we currently depart from (for "we don't fly from X" replies). */
  async listOrigins(): Promise<string[]> {
    const rows = await prisma.flight.findMany({
      distinct: ['origin'],
      select: { origin: true },
      orderBy: { origin: 'asc' }
    });
    return rows.map(r => r.origin);
  },

  /** Distinct destinations served from an origin (empty = origin not served). */
  async listDestinations(origin: string): Promise<string[]> {
    const rows = await prisma.flight.findMany({
      where: { origin: origin.toUpperCase() },
      distinct: ['destination'],
      select: { destination: true },
      orderBy: { destination: 'asc' }
    });
    return rows.map(r => r.destination);
  },

  /** First/last upcoming departure on a route, so "no flights on <date>" replies
   *  can point the user at dates that actually have availability. */
  async routeDateRange(origin: string, destination: string): Promise<{ first: Date; last: Date } | null> {
    const where = {
      origin: origin.toUpperCase(),
      destination: destination.toUpperCase(),
      departureTime: { gte: new Date() }
    };
    const first = await prisma.flight.findFirst({ where, orderBy: { departureTime: 'asc' } });
    if (!first) return null;
    const last = await prisma.flight.findFirst({ where, orderBy: { departureTime: 'desc' } });
    return { first: first.departureTime, last: last!.departureTime };
  },

  async searchFlights(origin: string, destination: string, dateStr: string) {
    logger.info(`Searching flights from ${origin} to ${destination} on date: ${dateStr}`);
    
    // Parse date range: from 00:00:00 of date to 23:59:59 of date
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      throw new Error('Invalid date format');
    }
    
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);
    
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    return prisma.flight.findMany({
      where: {
        origin: origin.toUpperCase(),
        destination: destination.toUpperCase(),
        departureTime: {
          gte: startDate,
          lte: endDate
        }
      },
      orderBy: {
        departureTime: 'asc'
      }
    });
  },

  async createBooking(flightId: string, passengerDetails: { name: string; email: string; phone: string }) {
    logger.info(`Creating new booking for flight ID: ${flightId} in database transaction`);
    
    return prisma.$transaction(async (tx) => {
      // 1. Get or create passenger
      let passenger = await tx.passenger.findUnique({
        where: { phone: passengerDetails.phone }
      });

      if (!passenger) {
        passenger = await tx.passenger.create({
          data: {
            name: passengerDetails.name,
            email: passengerDetails.email,
            phone: passengerDetails.phone
          }
        });
      }

      // 2. Verify flight exists
      const flight = await tx.flight.findUnique({
        where: { id: flightId }
      });

      if (!flight) {
        throw new Error('Flight not found');
      }

      // 3. Generate unique PNR (e.g. BW + 4 random digits)
      let pnr = '';
      let isUnique = false;
      while (!isUnique) {
        const rand = Math.floor(1000 + Math.random() * 9000);
        pnr = `BW${rand}`;
        const existing = await tx.booking.findUnique({ where: { pnr } });
        if (!existing) {
          isUnique = true;
        }
      }

      // 4. Create booking
      const booking = await tx.booking.create({
        data: {
          pnr,
          flightId: flight.id,
          passengerId: passenger.id,
          status: 'CONFIRMED'
        },
        include: {
          passenger: true,
          flight: true
        }
      });

      return booking;
    });
  },

  async rescheduleBooking(pnr: string, newFlightId: string) {
    logger.info(`Rescheduling PNR: ${pnr} to flight: ${newFlightId} in database transaction`);
    
    return prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { pnr: pnr.toUpperCase() },
        include: { passenger: true, flight: true }
      });

      if (!booking) {
        throw new Error('Booking not found');
      }

      if (booking.status === 'CANCELLED') {
        throw new Error('Cannot reschedule a cancelled booking');
      }

      const newFlight = await tx.flight.findUnique({
        where: { id: newFlightId }
      });

      if (!newFlight) {
        throw new Error('New flight not found');
      }

      const updated = await tx.booking.update({
        where: { id: booking.id },
        data: {
          flightId: newFlight.id,
          status: 'RESCHEDULED'
        },
        include: {
          passenger: true,
          flight: true // returns the newly-assigned flight (flightId was just updated above)
        }
      });

      return updated;
    });
  },

  async cancelBooking(pnr: string) {
    logger.info(`Cancelling PNR: ${pnr} in database transaction`);
    
    return prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { pnr: pnr.toUpperCase() },
        include: { passenger: true, flight: true }
      });

      if (!booking) {
        throw new Error('Booking not found');
      }

      if (booking.status === 'CANCELLED') {
        throw new Error('Booking is already cancelled');
      }

      const updated = await tx.booking.update({
        where: { id: booking.id },
        data: {
          status: 'CANCELLED'
        },
        include: {
          passenger: true,
          flight: true
        }
      });

      return updated;
    });
  },

  /**
   * All bookings belonging to the passenger who owns this PNR, newest journey
   * first. Powers the "my trips" view once the session is verified.
   */
  async listTripsForPnr(pnr: string) {
    const booking = await prisma.booking.findUnique({
      where: { pnr: pnr.toUpperCase() },
      select: { passengerId: true }
    });
    if (!booking) return null;
    return prisma.booking.findMany({
      where: { passengerId: booking.passengerId },
      include: { flight: true },
      orderBy: { flight: { departureTime: 'desc' } }
    });
  },

  /**
   * Ops simulation: delay the flight behind a PNR by N minutes and return the
   * affected active bookings so callers can notify those passengers proactively.
   */
  async delayFlightByPnr(pnr: string, minutes: number) {
    return prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { pnr: pnr.toUpperCase() },
        include: { flight: true }
      });
      if (!booking) {
        throw new Error('Booking not found');
      }

      const flight = await tx.flight.update({
        where: { id: booking.flightId },
        data: {
          departureTime: new Date(booking.flight.departureTime.getTime() + minutes * 60_000),
          arrivalTime: new Date(booking.flight.arrivalTime.getTime() + minutes * 60_000)
        }
      });

      const affected = await tx.booking.findMany({
        where: { flightId: flight.id, status: { not: 'CANCELLED' } },
        include: { passenger: true }
      });

      return { flight, affected };
    });
  }
};
