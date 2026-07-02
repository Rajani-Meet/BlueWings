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

    // Simple last-name match (checks if the lowercase last name is a substring or suffix of the passenger name)
    const passengerNameParts = booking.passenger.name.toLowerCase().split(/\s+/);
    const providedLastName = lastName.toLowerCase().trim();
    
    const matchesLastName = passengerNameParts.includes(providedLastName) || 
                            booking.passenger.name.toLowerCase().endsWith(providedLastName);

    if (!matchesLastName) {
      return { matchError: true };
    }

    // Deterministic gate assignment based on PNR characters
    const pnrSum = pnr.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const gates = ['Gate A12', 'Gate B4', 'Gate C18', 'Gate D9', 'Gate G24'];
    const assignedGate = gates[pnrSum % gates.length];

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
  }
};
