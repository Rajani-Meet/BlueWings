import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import prisma from '../src/db/prismaClient';
import { processIncomingMessage } from '../src/controllers/message.controller';
import { bookingService } from '../src/services/booking.service';
import { sessionService } from '../src/services/session.service';

/**
 * Integration tests for the 4 locked flows + agent handoff, driven through the
 * channel-agnostic core (processIncomingMessage) against the real database.
 *
 * - Self-contained fixtures (route TQA->TQB, flights TS9xx, PNRs BW97xx) are
 *   created in beforeAll and removed in afterAll, so tests are re-runnable and
 *   independent of the demo seed data.
 * - tests/setup.ts clears OPENROUTER_API_KEY, so intent parsing uses the
 *   deterministic keyword fallback (no network, no flakiness).
 */

const TEST_PHONE = '+911000009999';
const TEST_USER_PREFIX = 'vitest-';

function daysFromNow(days: number, hour: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function ymd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Shorthand: send one message as the given test user. */
async function say(userId: string, message: string) {
  return processIncomingMessage({ channel: 'PWA', userId: TEST_USER_PREFIX + userId, message });
}

let flightA: { id: string; flightNumber: string };
let flightB: { id: string; flightNumber: string };

async function cleanupFixtures() {
  await prisma.booking.deleteMany({
    where: {
      OR: [
        { pnr: { startsWith: 'BW97' } },
        { flight: { flightNumber: { startsWith: 'TS9' } } }
      ]
    }
  });
  await prisma.conversationSession.deleteMany({
    where: { channelUserId: { startsWith: TEST_USER_PREFIX } },
  });
  await prisma.passenger.deleteMany({
    where: {
      OR: [
        { phone: TEST_PHONE },
        { email: { startsWith: 'vitest' } },
        { email: { startsWith: 'retry' } }
      ]
    }
  });
  await prisma.flight.deleteMany({ where: { flightNumber: { startsWith: 'TS9' } } });
}

beforeAll(async () => {
  await cleanupFixtures();

  flightA = await prisma.flight.create({
    data: {
      flightNumber: 'TS901',
      origin: 'TQA',
      destination: 'TQB',
      departureTime: daysFromNow(1, 12),
      arrivalTime: daysFromNow(1, 14),
      price: 5000,
    },
  });
  flightB = await prisma.flight.create({
    data: {
      flightNumber: 'TS902',
      origin: 'TQA',
      destination: 'TQB',
      departureTime: daysFromNow(2, 12),
      arrivalTime: daysFromNow(2, 14),
      price: 6000,
    },
  });

  const passenger = await prisma.passenger.create({
    data: { name: 'Vitest Alpha', email: 'vitest.alpha@example.com', phone: TEST_PHONE },
  });

  // Pre-existing bookings for status / reschedule / cancel flows
  for (const pnr of ['BW9701', 'BW9702', 'BW9703']) {
    await prisma.booking.create({
      data: { pnr, flightId: flightA.id, passengerId: passenger.id, status: 'CONFIRMED' },
    });
  }
});

afterAll(async () => {
  await cleanupFixtures();
  await prisma.$disconnect();
});

describe('Flow 1: check booking status (with PNR + last name auth)', () => {
  it('returns flight details for a valid PNR + matching last name', async () => {
    await say('status-1', 'check my booking status');
    await say('status-1', 'BW9701');
    const res = await say('status-1', 'Alpha');

    expect(res.reply).toContain('Flight Status for PNR: BW9701');
    expect(res.reply).toContain('Vitest Alpha');
    expect(res.reply).toContain('TS901');
    expect(res.reply).toContain('CONFIRMED');
    expect(res.agentHandoff).toBe(false);
    expect(res.ticketUrl).toBe('/api/ticket/BW9701?lastName=Alpha'); // re-download from status check
  });

  it('rejects a non-matching last name and resets the flow', async () => {
    await say('status-2', 'status');
    await say('status-2', 'BW9701');
    const res = await say('status-2', 'Mallory');

    expect(res.reply).toContain('did not match');
    expect(res.sessionState.currentFlow).toBeNull();
  });

  it('handles an unknown PNR gracefully', async () => {
    await say('status-3', 'status');
    await say('status-3', 'BW9799');
    const res = await say('status-3', 'Alpha');

    expect(res.reply).toContain("couldn't find any booking");
  });
});

describe('Flow 2: book a new flight (search -> select -> pay -> PNR)', () => {
  it('books end-to-end and persists the booking', async () => {
    await say('book-1', 'I want to book a flight');
    await say('book-1', 'TQA');
    await say('book-1', 'TQB');
    const options = await say('book-1', ymd(daysFromNow(1, 0)));
    expect(options.reply).toContain('TS901');

    await say('book-1', 'TS901');
    await say('book-1', 'Vitest Beta');
    await say('book-1', 'vitest.beta@example.com');
    
    // Step 7: Enter phone
    const seatPrompt = await say('book-1', '+911000009998');
    expect(seatPrompt.reply).toContain('select your seat');
    expect(seatPrompt.reply).toContain('3A');
    expect(seatPrompt.suggestions).toContain('1A');

    // Step 8: Select seat '3A' (Standard Window, +Rs. 300)
    const confirm = await say('book-1', '3A');

    expect(confirm.reply).toContain('Booking Confirmed');
    expect(confirm.reply).toContain('Seat*: 3A');
    expect(confirm.reply).toContain('Amount Paid*: Rs. 5300'); // 5000 base + 300 window
    const pnrMatch = confirm.reply.match(/PNR\*?: (BW\d{4})/);
    expect(pnrMatch).not.toBeNull();

    // The confirmation carries a pre-authorized e-ticket download link
    expect(confirm.ticketUrl).toBe(`/api/ticket/${pnrMatch![1]}?lastName=Beta`);

    const booking = await prisma.booking.findUnique({
      where: { pnr: pnrMatch![1] },
      include: { passenger: true, flight: true },
    });
    expect(booking).not.toBeNull();
    expect(booking!.status).toBe('CONFIRMED');
    expect(booking!.flight.flightNumber).toBe('TS901');
    expect(booking!.passenger.name).toBe('Vitest Beta');
    expect(booking!.seatNumber).toBe('3A');
    expect(booking!.pricePaid).toBe(5300);

    // cleanup the extra passenger created by this flow
    await prisma.booking.delete({ where: { id: booking!.id } });
    await prisma.passenger.delete({ where: { id: booking!.passengerId } });
  });

  it('reports when no flights exist for the route/date, with available date range', async () => {
    await say('book-2', 'book');
    await say('book-2', 'TQA');
    await say('book-2', 'TQB');
    const res = await say('book-2', '2031-01-01');

    expect(res.reply).toContain('no flights found');
    expect(res.reply).toContain('available between'); // points at dates that do have flights
  });

  it('rejects an unserved origin and lists the airports we fly from', async () => {
    await say('book-3', 'book');
    const res = await say('book-3', 'QQQ');

    expect(res.reply).toContain("doesn't operate from *QQQ*");
    expect(res.reply).toContain('TQA');
  });

  it('rejects an unserved route and lists the destinations, instead of a date loop', async () => {
    await say('book-4', 'book');
    await say('book-4', 'TQA');
    const res = await say('book-4', 'ZZZ');

    expect(res.reply).toContain("doesn't fly *TQA ➔ ZZZ*");
    expect(res.reply).toContain('TQB'); // the destinations actually served from TQA
  });

  it('resolves city names like "testcitya" or "testcityb" to airport codes', async () => {
    await say('book-5', 'book');
    const step2 = await say('book-5', 'testcitya');
    expect(step2.reply).toContain('Flying from *TQA*');

    const step3 = await say('book-5', 'testcityb');
    expect(step3.reply).toContain('TQA ➔ TQB');
  });

  it('one-message booking: route + date in a single message jumps to options', async () => {
    const res = await say('book-6', `book testcitya to testcityb on ${ymd(daysFromNow(1, 0))}`);
    expect(res.reply).toContain('TS901');
    expect(res.sessionState.step).toBe(4);
    expect(res.sessionState.slots.origin).toBe('TQA');
    expect(res.sessionState.slots.destination).toBe('TQB');
  });

  it('one-message booking: route without date jumps to the date prompt', async () => {
    const res = await say('book-7', 'book a flight from testcitya to testcityb');
    expect(res.reply).toContain('What date');
    expect(res.sessionState.step).toBe(3);
  });

  it('one-message booking: invalid extracted slots fall back to step-by-step', async () => {
    const res = await say('book-8', 'i want to book a trip');
    expect(res.reply).toContain('Which city are you flying *from*');
    expect(res.sessionState.step).toBe(1);
  });

  it('declined payment (phone ending 0000) keeps the flow alive for retry', async () => {
    await say('book-9', `book testcitya to testcityb on ${ymd(daysFromNow(1, 0))}`);
    await say('book-9', 'TS901');
    await say('book-9', 'Retry Passenger');
    await say('book-9', 'retry.passenger@example.com');

    // Step 7: Enter phone ending in 0000
    const seatPrompt = await say('book-9', '+911234560000');
    expect(seatPrompt.reply).toContain('select your seat');

    // Step 8: Select seat '3A' -> triggers payment and fails
    const declined = await say('book-9', '3A');
    expect(declined.reply).toContain('Payment Declined');
    expect(declined.sessionState.currentFlow).toBe('BOOK'); // details preserved
    expect(declined.sessionState.slots.seatNumber).toBe('3A');

    // Retry with a successful phone number
    const confirmed = await say('book-9', '+911234567891');
    expect(confirmed.reply).toContain('Booking Confirmed');
    expect(confirmed.reply).toContain('Seat*: 3A');
    expect(confirmed.reply).toContain('Amount Paid*: Rs. 5300');

    // cleanup the booking + passenger this test created
    const pnr = confirmed.reply.match(/PNR\*?: (BW\d{4})/)![1];
    const booking = await prisma.booking.findUnique({ where: { pnr } });
    await prisma.booking.delete({ where: { id: booking!.id } });
    await prisma.passenger.delete({ where: { id: booking!.passengerId } });
  });

  it('rejects an invalid/occupied seat, then prices a premium seat correctly', async () => {
    await say('book-10', `book testcitya to testcityb on ${ymd(daysFromNow(1, 0))}`);
    await say('book-10', 'TS901');
    await say('book-10', 'Premium Flyer');
    await say('book-10', 'premium.flyer@example.com');
    await say('book-10', '+911234511111'); // -> seat map

    // A seat not on the map is rejected, flow stays on seat selection
    const bad = await say('book-10', '9Z');
    expect(bad.reply).toContain('Invalid or occupied seat');
    expect(bad.sessionState.currentFlow).toBe('BOOK');

    // 1A = Premium Window (+Rs. 1000) on a base fare of 5000
    const confirmed = await say('book-10', '1A');
    expect(confirmed.reply).toContain('Booking Confirmed');
    expect(confirmed.reply).toContain('Seat*: 1A (Premium Window)');
    expect(confirmed.reply).toContain('Amount Paid*: Rs. 6000');

    const pnr = confirmed.reply.match(/PNR\*?: (BW\d{4})/)![1];
    const booking = await prisma.booking.findUnique({ where: { pnr } });
    expect(booking!.seatNumber).toBe('1A');
    expect(booking!.pricePaid).toBe(6000);
    await prisma.booking.delete({ where: { id: booking!.id } });
    await prisma.passenger.delete({ where: { id: booking!.passengerId } });
  });
});


describe('Flow 3: reschedule (PNR -> alternatives -> confirm)', () => {
  it('reschedules to an alternative flight and updates the booking', async () => {
    await say('resched-1', 'reschedule my flight');
    await say('resched-1', 'BW9702');
    await say('resched-1', 'Alpha');
    const options = await say('resched-1', ymd(daysFromNow(2, 0)));
    expect(options.reply).toContain('TS902');

    const res = await say('resched-1', 'TS902');
    expect(res.reply).toContain('Rescheduled Successfully');

    const booking = await prisma.booking.findUnique({ where: { pnr: 'BW9702' } });
    expect(booking!.status).toBe('RESCHEDULED');
    expect(booking!.flightId).toBe(flightB.id);
  });
});

describe('Flow 4: cancel (PNR -> confirm -> simulated refund)', () => {
  it('cancels after YES confirmation and reports a refund', async () => {
    await say('cancel-1', 'cancel my booking');
    await say('cancel-1', 'BW9703');
    const confirmPrompt = await say('cancel-1', 'Alpha');
    expect(confirmPrompt.reply).toContain('Confirm Cancellation');

    const res = await say('cancel-1', 'yes');
    expect(res.reply).toContain('Cancelled Successfully');
    expect(res.reply).toContain('Refund');
    expect(res.reply).toContain('Rs. 5000'); // simulated refund = actual fare of flight TS901

    const booking = await prisma.booking.findUnique({ where: { pnr: 'BW9703' } });
    expect(booking!.status).toBe('CANCELLED');
  });

  it('aborts cancellation on NO and keeps the booking', async () => {
    // BW9701 is still CONFIRMED from Flow 1 tests
    await say('cancel-2', 'cancel');
    await say('cancel-2', 'BW9701');
    await say('cancel-2', 'Alpha');
    const res = await say('cancel-2', 'no');

    expect(res.reply).toContain('aborted');
    const booking = await prisma.booking.findUnique({ where: { pnr: 'BW9701' } });
    expect(booking!.status).toBe('CONFIRMED');
  });
});

describe('Agent handoff triggers', () => {
  it('hands off after 2 consecutive failed intent parses', async () => {
    const first = await say('handoff-1', 'zzz qqq blorp');
    expect(first.agentHandoff).toBe(false);

    const second = await say('handoff-1', 'flurb glorp zzz');
    expect(second.agentHandoff).toBe(true);
    expect(second.reply).toContain('agent');
  });

  it('hands off immediately on an explicit agent request', async () => {
    const res = await say('handoff-2', 'let me talk to a human agent');
    expect(res.agentHandoff).toBe(true);
  });

  it('keeps the session in handoff state for subsequent messages', async () => {
    const res = await say('handoff-2', 'hello?');
    expect(res.agentHandoff).toBe(true);
    expect(res.reply).toContain('representative');
  });

  it("returns to the bot when the user types 'menu' after handoff", async () => {
    const back = await say('handoff-2', 'menu');
    expect(back.agentHandoff).toBe(false);
    expect(back.reply).toContain('back with the BlueWings assistant');

    // The bot is fully functional again afterwards.
    const followup = await say('handoff-2', 'status');
    expect(followup.agentHandoff).toBe(false);
    expect(followup.reply).toContain('PNR');
  });
});

describe('My trips (list all bookings)', () => {
  it('verifies once and lists every booking of the passenger', async () => {
    await say('trips-1', 'show my bookings');
    await say('trips-1', 'BW9701');
    const res = await say('trips-1', 'Alpha');

    expect(res.reply).toContain('Your Trips');
    expect(res.reply).toContain('BW9701');
    expect(res.reply).toContain('BW9702');
    expect(res.reply).toContain('BW9703');
  });

  it('answers immediately when the session is already verified', async () => {
    await say('trips-2', 'status');
    await say('trips-2', 'BW9701');
    await say('trips-2', 'Alpha');

    const res = await say('trips-2', 'my trips');
    expect(res.reply).toContain('Your Trips');
    expect(res.sessionState.currentFlow).toBeNull(); // no re-auth round trip
  });

  it("does not hijack action phrases like 'cancel my booking'", async () => {
    const res = await say('trips-3', 'cancel my booking');
    expect(res.sessionState.currentFlow).toBe('CANCEL');
  });
});

describe('Hinglish input (keyword fallback)', () => {
  it("'ticket radd karo' starts the cancel flow", async () => {
    const res = await say('hindi-1', 'meri ticket radd karo BW9701');
    expect(res.sessionState.currentFlow).toBe('CANCEL');
    expect(res.sessionState.slots.pnr).toBe('BW9701');
  });

  it("'flight badalni hai' starts the reschedule flow", async () => {
    const res = await say('hindi-2', 'mujhe apni flight badalni hai');
    expect(res.sessionState.currentFlow).toBe('RESCHEDULE');
  });

  it("'meri flight kab hai' starts the status flow", async () => {
    const res = await say('hindi-3', 'meri flight kab hai');
    expect(res.sessionState.currentFlow).toBe('CHECK_STATUS');
  });
});

describe('Proactive delay notification', () => {
  it('delays the flight and surfaces a notice on the next chat turn', async () => {
    // Verify a session against BW9701 so the notice can find it.
    await say('delay-1', 'status');
    await say('delay-1', 'BW9701');
    await say('delay-1', 'Alpha');

    const before = await prisma.flight.findUnique({ where: { id: flightA.id } });
    const { flight, affected } = await bookingService.delayFlightByPnr('BW9701', 60);
    expect(flight.departureTime.getTime()).toBe(before!.departureTime.getTime() + 60 * 60_000);
    expect(affected.map(b => b.pnr)).toContain('BW9701');

    const notified = await sessionService.addPendingNoticeByPnr('BW9701', '⚠️ *Flight Update* — test delay notice');
    expect(notified).toBeGreaterThan(0);

    // The next message — any message — carries the notice on top.
    const res = await say('delay-1', 'thanks');
    expect(res.reply).toContain('Flight Update');
    expect(res.reply).toContain('test delay notice');

    // Delivered exactly once: the following turn is clean.
    const after = await say('delay-1', 'hello');
    expect(after.reply).not.toContain('Flight Update');
  });
});

describe('Greeting/help pre-check (MENU intent)', () => {
  it("shows the menu for 'help' instead of joining the agent queue", async () => {
    const res = await say('greet-1', 'help');
    expect(res.agentHandoff).toBe(false);
    expect(res.reply).toContain('How can I help you today');
  });

  it('never counts greetings as failed parses (no handoff on repeats)', async () => {
    await say('greet-2', 'hi');
    await say('greet-2', 'help');
    const third = await say('greet-2', 'hello');
    expect(third.agentHandoff).toBe(false);
    expect(third.reply).toContain('How can I help you today');
  });

  it("still routes messages with a concrete ask normally ('help me cancel...')", async () => {
    const res = await say('greet-3', 'help me cancel my flight');
    expect(res.agentHandoff).toBe(false);
    expect(res.sessionState.currentFlow).toBe('CANCEL');
  });
});

describe('Session-persistent authentication (verify once per session)', () => {
  it('skips re-auth when a flow starts with an already-verified PNR', async () => {
    await say('auth-1', 'status');
    await say('auth-1', 'BW9701');
    const verified = await say('auth-1', 'Alpha');
    expect(verified.reply).toContain('Flight Status for PNR: BW9701');

    // Same session, same PNR: cancel jumps straight to the confirmation prompt.
    const res = await say('auth-1', 'cancel my booking BW9701');
    expect(res.reply).toContain('Confirm Cancellation');

    const aborted = await say('auth-1', 'no');
    expect(aborted.reply).toContain('aborted');
  });

  it('skips re-auth when the verified PNR is entered mid-flow', async () => {
    await say('auth-2', 'check status of BW9701');
    await say('auth-2', 'Alpha');

    await say('auth-2', 'reschedule');
    const res = await say('auth-2', 'BW9701');
    expect(res.reply).toContain('What new date');
  });

  it('still asks for the last name for a different, unverified PNR', async () => {
    await say('auth-3', 'status');
    await say('auth-3', 'BW9701');
    await say('auth-3', 'Alpha'); // verified for BW9701 only

    await say('auth-3', 'cancel');
    const res = await say('auth-3', 'BW9702');
    expect(res.reply).toContain('last name');
  });
});

describe('E-ticket PDF generation', () => {
  it('renders a valid PDF with the booking details', async () => {
    const booking = await prisma.booking.findUnique({
      where: { pnr: 'BW9701' },
      include: { passenger: true, flight: true },
    });
    expect(booking).not.toBeNull();

    const { buildTicketData, renderTicketPdf } = await import('../src/services/ticket.service');
    const data = buildTicketData(booking!);
    expect(data.pnr).toBe('BW9701');
    expect(data.passengerName).toBe('Vitest Alpha');
    expect(data.seat).toMatch(/^\d{1,2}[A-F]$/);
    expect(data.gate).toContain('Gate');

    const pdf = await renderTicketPdf(data);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-'); // PDF magic bytes
    expect(pdf.length).toBeGreaterThan(1500);
  });
});

describe('Quick-reply suggestions', () => {
  it('offers the menu chips when idle', async () => {
    const idle = await say('sugg-1', 'hello there');
    expect(idle.suggestions).toContain('Check status');
    expect(idle.suggestions).toContain('Talk to an agent');
  });

  it('offers Yes/No at the cancellation confirmation', async () => {
    await say('sugg-1', 'cancel');
    await say('sugg-1', 'BW9701');
    const confirm = await say('sugg-1', 'Alpha');
    expect(confirm.suggestions).toEqual(['Yes', 'No']);
    await say('sugg-1', 'no');
  });

  it('offers a way back to the menu during agent handoff', async () => {
    const res = await say('sugg-2', 'talk to an agent please');
    expect(res.agentHandoff).toBe(true);
    expect(res.suggestions).toEqual(['Back to menu']);
  });
});
