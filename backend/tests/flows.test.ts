import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import prisma from '../src/db/prismaClient';
import { processIncomingMessage } from '../src/controllers/message.controller';

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
  await prisma.booking.deleteMany({ where: { pnr: { startsWith: 'BW97' } } });
  await prisma.conversationSession.deleteMany({
    where: { channelUserId: { startsWith: TEST_USER_PREFIX } },
  });
  await prisma.passenger.deleteMany({ where: { phone: TEST_PHONE } });
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
    const confirm = await say('book-1', '+911000009998');

    expect(confirm.reply).toContain('Booking Confirmed');
    const pnrMatch = confirm.reply.match(/PNR\*?: (BW\d{4})/);
    expect(pnrMatch).not.toBeNull();

    const booking = await prisma.booking.findUnique({
      where: { pnr: pnrMatch![1] },
      include: { passenger: true, flight: true },
    });
    expect(booking).not.toBeNull();
    expect(booking!.status).toBe('CONFIRMED');
    expect(booking!.flight.flightNumber).toBe('TS901');
    expect(booking!.passenger.name).toBe('Vitest Beta');

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
