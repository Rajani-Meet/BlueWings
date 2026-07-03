import { Request, Response } from 'express';
import { MessagePayload, MessagePayloadSchema } from '../models/message.schema';
import { logger } from '../utils/logger';
import { sessionService, SessionState } from '../services/session.service';
import { parseIntent, keywordParseIntent } from '../services/intentRouter.service';
import { bookingService } from '../services/booking.service';
import { paymentService } from '../services/payment.service';
import prisma from '../db/prismaClient';

export interface MessageResult {
  reply: string;
  sessionState: SessionState;
  agentHandoff: boolean;
  /** Quick-reply chips for channels that support them (PWA renders buttons; WhatsApp ignores). */
  suggestions?: string[];
  /** Relative URL of the downloadable e-ticket PDF, set when a booking was just
   *  confirmed, rescheduled, or looked up (PWA renders a download button). */
  ticketUrl?: string;
}

/** Download link for the e-ticket endpoint, pre-authorized with the verified last name. */
function buildTicketUrl(pnr: string, lastName: string): string {
  return `/api/ticket/${pnr}?lastName=${encodeURIComponent(lastName)}`;
}

const MENU_TEXT =
  'How can I help you today? You can choose from:\n' +
  "1. *Check booking status* (type 'status')\n" +
  "2. *Book a new flight* (type 'book')\n" +
  "3. *Reschedule flight* (type 'reschedule')\n" +
  "4. *Cancel booking* (type 'cancel')\n" +
  "5. *Talk to an agent* (type 'agent')";

const MENU_SUGGESTIONS = ['Check status', 'Book a flight', 'Reschedule', 'Cancel booking', 'Talk to an agent'];

const RETURN_TO_BOT_HINT = '\n\n_Type *menu* to return to the automated assistant at any time._';

/** Matches an explicit request to leave the (simulated) agent queue and resume the bot. */
const RESUME_BOT_REGEX = /\bmenu\b|\bresume\b|\bmain menu\b|\bstart over\b|back to (the )?(bot|menu|assistant)/;

/** YYYY-MM-DD in IST, for pointing users at dates that have flights. */
function ymdIST(date: Date): string {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function generateSeatMap(occupiedSeats: Set<string>) {
  const rows = [1, 2, 3, 4, 5];
  const cols = ['A', 'B', 'C', 'D', 'E', 'F'];
  const availableSeats: string[] = [];
  
  let mapLines: string[] = [];
  
  mapLines.push('💺 *SEAT MAP*');
  mapLines.push('`[ ]` = Available | `[X]` = Occupied\n');
  
  mapLines.push('👑 *Premium (+Rs. 800)*');
  for (let r of [1, 2]) {
    let rowParts: string[] = [];
    for (let c of cols) {
      const seat = `${r}${c}`;
      if (occupiedSeats.has(seat)) {
        rowParts.push('`[X]`');
      } else {
        rowParts.push(`\`[${seat}]\``);
        availableSeats.push(seat);
      }
      if (c === 'C') rowParts.push('  '); // aisle gap
    }
    mapLines.push(`Row ${r}: ${rowParts.join(' ')}`);
  }
  
  mapLines.push('\n✈️ *Standard (Window +Rs. 300 / Aisle +Rs. 200 / Middle +Rs. 0)*');
  for (let r of [3, 4, 5]) {
    let rowParts: string[] = [];
    for (let c of cols) {
      const seat = `${r}${c}`;
      if (occupiedSeats.has(seat)) {
        rowParts.push('`[X]`');
      } else {
        rowParts.push(`\`[${seat}]\``);
        availableSeats.push(seat);
      }
      if (c === 'C') rowParts.push('  '); // aisle gap
    }
    mapLines.push(`Row ${r}: ${rowParts.join(' ')}`);
  }
  
  return {
    seatMapText: mapLines.join('\n'),
    availableSeats
  };
}

/** True when this session already verified PNR + last name for exactly this PNR. */
function isSessionVerifiedFor(state: SessionState, pnr: string | undefined): boolean {
  return !!(pnr && state.auth.verified && state.auth.pnr === pnr && state.auth.lastName);
}

const CITY_TO_AIRPORT: Record<string, string> = {
  mumbai: 'BOM',
  bombay: 'BOM',
  delhi: 'DEL',
  newdelhi: 'DEL',
  bangalore: 'BLR',
  bengaluru: 'BLR',
  ahmedabad: 'AMD',
  hyderabad: 'HYD',
  chennai: 'MAA',
  madras: 'MAA',
  kolkata: 'CCU',
  calcutta: 'CCU',
  pune: 'PNQ',
  kochi: 'COK',
  cochin: 'COK',
  jaipur: 'JAI',
  goa: 'GOI',
  lucknow: 'LKO',
  testcitya: 'TQA',
  testcityb: 'TQB'
};


function resolveAirportCode(input: string): string {
  const cleaned = input.toLowerCase().trim().replace(/\s+/g, '');
  if (CITY_TO_AIRPORT[cleaned]) {
    return CITY_TO_AIRPORT[cleaned];
  }
  return input.toUpperCase().trim();
}


/**
 * Search flights for a date and write the options into the session (step 4 on
 * success). Shared by the BOOK step-3 handler and the one-message booking path
 * ("book mumbai to delhi on 2026-07-06"). Mutates `state`; returns the reply.
 */
async function presentFlightOptionsForDate(state: SessionState, inputDate: string): Promise<string> {
  const flights = await bookingService.searchFlights(state.slots.origin!, state.slots.destination!, inputDate);
  if (flights.length === 0) {
    const range = await bookingService.routeDateRange(state.slots.origin!, state.slots.destination!);
    if (!range) {
      // Route has no upcoming flights at all — asking for more dates is a
      // dead end; send the user back to pick a served destination.
      const destinations = await bookingService.listDestinations(state.slots.origin!);
      const reply = `Sorry, BlueWings has no upcoming flights from *${state.slots.origin} ➔ ${state.slots.destination}*. ✈️\n\n` +
              `From *${state.slots.origin}* we currently serve: *${destinations.join(', ')}*.\n` +
              `Please choose one of these destinations.`;
      state.slots.destination = undefined;
      state.step = 2;
      return reply;
    }
    return `Sorry, no flights found from ${state.slots.origin} to ${state.slots.destination} on *${inputDate}*.\n\n` +
           `Flights on this route are currently available between *${ymdIST(range.first)}* and *${ymdIST(range.last)}*. ` +
           `Please try another date (YYYY-MM-DD), or type 'agent' to speak with a representative.`;
  }

  const flightOptions = flights.slice(0, 3);
  state.slots.availableFlights = flightOptions.map(f => ({
    id: f.id,
    flightNumber: f.flightNumber,
    departureTime: f.departureTime,
    price: f.price
  }));

  let optionsText = `Here are the available flights from ${state.slots.origin} to ${state.slots.destination} on *${inputDate}*:\n\n`;
  flightOptions.forEach((f, idx) => {
    const depTime = new Date(f.departureTime).toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit'
    });
    optionsText += `*${idx + 1}. ${f.flightNumber}* | Departs: ${depTime} | Price: Rs. ${f.price}\n`;
  });
  optionsText += `\nReply with the flight number you'd like to book (e.g., *${flightOptions[0].flightNumber}*).`;
  state.slots.date = inputDate;
  state.step = 4;
  return optionsText;
}

/** Format the passenger's bookings as a numbered trips list. */
async function buildTripsReply(pnr: string): Promise<string> {
  const trips = await bookingService.listTripsForPnr(pnr);
  if (!trips || trips.length === 0) {
    return `We couldn't find any trips linked to PNR *${pnr}*.`;
  }
  let text = `🧳 *Your Trips* (${trips.length})\n\n`;
  trips.forEach((t, i) => {
    const dep = new Date(t.flight.departureTime).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
    });
    const badge = t.status === 'CANCELLED' ? '❌' : t.status === 'RESCHEDULED' ? '🔄' : '✅';
    text += `*${i + 1}. ${t.pnr}* ${badge} ${t.flight.flightNumber} ${t.flight.origin} ➔ ${t.flight.destination}\n` +
            `    ${dep} · ${t.status}\n`;
  });
  text += `\nUse a PNR with 'status', 'reschedule', or 'cancel' to manage a trip.`;
  return text;
}

/** Quick-reply chips for the current conversation point. */
function buildSuggestions(result: MessageResult): string[] {
  if (result.agentHandoff) return ['Back to menu'];
  const state = result.sessionState;
  if (state.currentFlow === null) return MENU_SUGGESTIONS;
  if (state.currentFlow === 'CANCEL' && state.step === 3) return ['Yes', 'No'];
  if (state.currentFlow === 'BOOK' && state.step === 8) {
    const seats: string[] = state.slots.availableSeatList || [];
    return seats.slice(0, 5);
  }
  return [];
}

/** Express handler for POST /api/message (PWA + tests). Thin HTTP wrapper. */
export async function handleMessage(req: Request, res: Response) {
  try {
    const payload = MessagePayloadSchema.parse(req.body);
    const result = await processIncomingMessage(payload);
    res.json(result);
  } catch (error: any) {
    // Only payload validation can throw here; processing errors are handled inside.
    logger.error('Invalid /message payload', error);
    res.status(400).json({ error: error.message || 'Invalid request format' });
  }
}

/**
 * Channel-agnostic core: takes a validated internal payload, returns the bot's
 * response. Called by the HTTP route and by channel adapters (e.g. WhatsApp).
 */
export async function processIncomingMessage(payload: MessagePayload): Promise<MessageResult> {
  // Proactive ops notices (e.g. flight delays) ride on top of the next reply.
  // Consumed (read-and-cleared) before processing so it is delivered exactly once.
  const notice = await sessionService.consumePendingNotice(payload.channel, payload.userId);
  const result = await processCore(payload);
  if (notice) {
    result.reply = `${notice}\n\n${result.reply}`;
  }
  return { ...result, suggestions: buildSuggestions(result) };
}

async function processCore(payload: MessagePayload): Promise<MessageResult> {
  const { channel, userId, message } = payload;
  try {

    // 1. Get or create session
    const session = await sessionService.getOrCreateSession(channel, userId);
    const sessionId = session.id;
    let state = session.state;

    logger.logMessage('INBOUND', userId, message, state.slots.pnr, state.slots.lastName);

    // 2. Check if agent handoff is active (simulated queue — no real agents in the MVP).
    // The user can leave the queue and resume the bot at any time by typing 'menu'.
    if (session.agentHandoffActive) {
      if (RESUME_BOT_REGEX.test(message.toLowerCase().trim())) {
        await sessionService.clearSessionState(sessionId);
        const resumeReply = "You're back with the BlueWings assistant. ✈️\n\n" + MENU_TEXT;
        logger.logMessage('OUTBOUND', userId, resumeReply);
        return {
          reply: resumeReply,
          sessionState: { currentFlow: null, step: 0, slots: {}, auth: { verified: false }, consecutiveFailedParses: 0 },
          agentHandoff: false
        };
      }
      const handoffReply =
        '👩‍💼 *Agent (simulated)*: Thanks for waiting — a BlueWings representative has your conversation and will assist you right here.' +
        RETURN_TO_BOT_HINT;
      logger.logMessage('OUTBOUND', userId, handoffReply);
      return { reply: handoffReply, sessionState: state, agentHandoff: true };
    }

    let reply = '';
    let agentHandoff = false;
    let ticketUrl: string | undefined;

    // 3. Parse intent and slots from the user message.
    // Mid-flow, inputs are slot values ("BOM", "Doe", "yes") consumed by the state
    // machine — only the 'agent' escape hatch matters, which the keyword router
    // catches. Skip the LLM there to avoid needless latency and API usage.
    const parsed = state.currentFlow !== null
      ? keywordParseIntent(message)
      : await parseIntent(message);
    const intent = parsed.intent;

    // Handle consecutive failed intent parses (max 2 before handoff)
    if (intent === 'UNKNOWN' && state.currentFlow === null) {
      state.consecutiveFailedParses += 1;
      if (state.consecutiveFailedParses >= 2) {
        await sessionService.setAgentHandoff(sessionId, true);
        reply = "I'm having trouble understanding your request. Connecting you to an agent for support..." + RETURN_TO_BOT_HINT;
        logger.logMessage('OUTBOUND', userId, reply);
        state.consecutiveFailedParses = 0; // reset
        await sessionService.updateSessionState(sessionId, state);
        return { reply, sessionState: state, agentHandoff: true };
      }
    } else {
      if (intent !== 'UNKNOWN') {
        state.consecutiveFailedParses = 0; // Reset on successful parse
      }
    }

    // 4. Handle Explicit Agent Handoff
    if (intent === 'AGENT_HANDOFF') {
      await sessionService.setAgentHandoff(sessionId, true);
      reply = "Understood. I am connecting you to a BlueWings customer service agent..." + RETURN_TO_BOT_HINT;
      logger.logMessage('OUTBOUND', userId, reply);
      return { reply, sessionState: state, agentHandoff: true };
    }

    // 5. Dialogue State Machine & Slot Filling
    // Check if we are currently mid-flow
    if (state.currentFlow === 'CHECK_STATUS') {
      // If we don't have a PNR, check if the input is a valid PNR
      if (!state.slots.pnr) {
        const inputPnr = message.toUpperCase().replace(/\s+/g, '');
        if (/^BW\d{4}$/.test(inputPnr)) {
          state.slots.pnr = inputPnr;
          state.step = 2;
          if (isSessionVerifiedFor(state, inputPnr)) {
            // Already verified for this PNR in this session — skip re-auth, fall through.
            state.slots.lastName = state.auth.lastName;
          } else {
            reply = `I found PNR *${inputPnr}*. Please enter the passenger's last name to verify your identity.`;
            await sessionService.updateSessionState(sessionId, state);
            logger.logMessage('OUTBOUND', userId, reply, state.slots.pnr);
            return { reply, sessionState: state, agentHandoff: false };
          }
        } else {
          reply = "Invalid PNR format. Please enter your PNR in the format BW1234 (e.g., BW9001).";
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply);
          return { reply, sessionState: state, agentHandoff: false };
        }
      }

      // If we have a PNR but don't have last name, check if input is last name
      if (state.slots.pnr && !state.slots.lastName) {
        const inputLastName = message.trim();
        if (inputLastName.length > 0) {
          state.slots.lastName = inputLastName;
        } else {
          reply = "Please enter a valid passenger last name.";
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply);
          return { reply, sessionState: state, agentHandoff: false };
        }
      }

      // If slots are complete, authenticate and return results
      if (state.slots.pnr && state.slots.lastName) {
        const statusResult = await bookingService.checkBookingStatus(state.slots.pnr, state.slots.lastName);
        
        if (!statusResult) {
          reply = `We couldn't find any booking with PNR *${state.slots.pnr}*. Please start over by typing 'status'.`;
          state.currentFlow = null;
          state.slots = {};
        } else if (statusResult.matchError) {
          reply = `The passenger last name did not match our records for PNR *${state.slots.pnr}*. Please start over by typing 'status'.`;
          state.currentFlow = null;
          state.slots = {};
        } else {
          const b = statusResult.booking;
          // Remember the verified identity for the rest of the session (no re-auth for this PNR).
          state.auth = { pnr: b.pnr, lastName: state.slots.lastName, verified: true };
          const formattedDep = new Date(b.departureTime).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            dateStyle: 'medium',
            timeStyle: 'short'
          });

          reply = `✈️ *Flight Status for PNR: ${b.pnr}*\n\n` +
                  `• *Passenger*: ${b.passengerName}\n` +
                  `• *Flight*: ${b.flightNumber} (${b.origin} ➔ ${b.destination})\n` +
                  `• *Departure Time*: ${formattedDep}\n` +
                  `• *Booking Status*: ${b.status}\n` +
                  `• *Assigned Terminal/Gate*: ${b.gate}\n\n` +
                  `Is there anything else I can help you with?`;

          if (b.status !== 'CANCELLED') {
            ticketUrl = buildTicketUrl(b.pnr, state.slots.lastName!);
          }
          state.currentFlow = null;
          state.slots = {};
        }
      }
    } 
    
    else if (state.currentFlow === 'CANCEL') {
      // 1. Collect PNR
      if (!state.slots.pnr) {
        const inputPnr = message.toUpperCase().replace(/\s+/g, '');
        if (/^BW\d{4}$/.test(inputPnr)) {
          state.slots.pnr = inputPnr;
          state.step = 2;
          if (isSessionVerifiedFor(state, inputPnr)) {
            // Already verified for this PNR in this session — skip re-auth, fall through.
            state.slots.lastName = state.auth.lastName;
          } else {
            reply = `I found PNR *${inputPnr}*. Please enter the passenger's last name to authorize the cancellation.`;
            await sessionService.updateSessionState(sessionId, state);
            logger.logMessage('OUTBOUND', userId, reply, state.slots.pnr);
            return { reply, sessionState: state, agentHandoff: false };
          }
        } else {
          reply = "Invalid PNR format. Please enter your PNR in the format BW1234 (e.g., BW9001).";
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply);
          return { reply, sessionState: state, agentHandoff: false };
        }
      }

      // 2. Collect Last Name & Verify
      if (state.slots.pnr && !state.slots.lastName) {
        const inputLastName = message.trim();
        if (inputLastName.length > 0) {
          state.slots.lastName = inputLastName;
        } else {
          reply = "Please enter a valid passenger last name.";
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply);
          return { reply, sessionState: state, agentHandoff: false };
        }
      }

      // 3. Authenticate & Ask Confirmation
      if (state.step === 2 && state.slots.pnr && state.slots.lastName) {
        const statusResult = await bookingService.checkBookingStatus(state.slots.pnr, state.slots.lastName);
        if (!statusResult) {
          reply = `We couldn't find any booking with PNR *${state.slots.pnr}*. Please start over by typing 'cancel'.`;
          state.currentFlow = null;
          state.slots = {};
        } else if (statusResult.matchError) {
          reply = `The passenger last name did not match our records for PNR *${state.slots.pnr}*. Please start over by typing 'cancel'.`;
          state.currentFlow = null;
          state.slots = {};
        } else {
          const b = statusResult.booking;
          // Remember the verified identity for the rest of the session (no re-auth for this PNR).
          state.auth = { pnr: b.pnr, lastName: state.slots.lastName, verified: true };
          if (b.status === 'CANCELLED') {
            reply = `The booking for PNR *${b.pnr}* is already CANCELLED.`;
            state.currentFlow = null;
            state.slots = {};
          } else {
            const formattedDep = new Date(b.departureTime).toLocaleString('en-IN', { 
              timeZone: 'Asia/Kolkata', 
              dateStyle: 'medium', 
              timeStyle: 'short' 
            });
            reply = `⚠️ *Confirm Cancellation*\n\n` +
                    `We found a confirmed booking for *${b.passengerName}*:\n` +
                    `• *Flight*: ${b.flightNumber} (${b.origin} ➔ ${b.destination})\n` +
                    `• *Departure*: ${formattedDep}\n\n` +
                    `Are you sure you want to cancel this booking? This action is permanent.\n` +
                    `Reply *YES* to cancel, or *NO* to abort.`;
            state.step = 3;
            // Store flight details for potential refund calculation
            state.slots.passengerName = b.passengerName;
            state.slots.flightNumber = b.flightNumber;
            state.slots.route = `${b.origin} ➔ ${b.destination}`;
          }
        }
        await sessionService.updateSessionState(sessionId, state);
        logger.logMessage('OUTBOUND', userId, reply, state.slots.pnr, state.slots.lastName);
        return { reply, sessionState: state, agentHandoff: false };
      }

      // 4. Confirm or Abort
      if (state.step === 3) {
        const normalizedMsg = message.toLowerCase().trim();
        
        // Cancellation Dispute Handoff Trigger
        if (
          normalizedMsg.includes('refund amount') || 
          normalizedMsg.includes('charge') || 
          normalizedMsg.includes('fee') || 
          normalizedMsg.includes('unfair') || 
          normalizedMsg.includes('dispute') ||
          normalizedMsg.includes('complain')
        ) {
          await sessionService.setAgentHandoff(sessionId, true);
          reply = "I see you have concerns about the cancellation policy or refund fees. I am transferring you to a customer service agent to assist you immediately..." + RETURN_TO_BOT_HINT;
          logger.logMessage('OUTBOUND', userId, reply);
          return { reply, sessionState: state, agentHandoff: true };
        }

        if (normalizedMsg === 'yes' || normalizedMsg === 'confirm') {
          const cancelResult = await bookingService.cancelBooking(state.slots.pnr!);
          const refundAmount = cancelResult.flight.price; // Simulated full refund of the fare
          reply = `❌ *Booking Cancelled Successfully*\n\n` +
                  `Your flight booking for PNR *${cancelResult.pnr}* has been cancelled.\n` +
                  `• *Refund Amount*: Rs. ${refundAmount} (processed to original payment method)\n` +
                  `• *Status*: Refund Initiated\n` +
                  `• *Transaction ID*: TXN-${Math.random().toString(36).substring(2, 11).toUpperCase()}\n\n` +
                  `We hope to fly with you again soon!`;
          state.currentFlow = null;
          state.slots = {};
        } else if (normalizedMsg === 'no' || normalizedMsg === 'abort') {
          reply = `Cancellation aborted. Your booking for PNR *${state.slots.pnr}* remains confirmed and active.`;
          state.currentFlow = null;
          state.slots = {};
        } else {
          reply = "I didn't catch that. Please reply with *YES* to cancel your flight, or *NO* to keep your booking.";
        }
      }
    } 
    
    else if (state.currentFlow === 'RESCHEDULE') {
      // 1. Collect PNR
      if (!state.slots.pnr) {
        const inputPnr = message.toUpperCase().replace(/\s+/g, '');
        if (/^BW\d{4}$/.test(inputPnr)) {
          state.slots.pnr = inputPnr;
          state.step = 2;
          if (isSessionVerifiedFor(state, inputPnr)) {
            // Already verified for this PNR in this session — skip re-auth, fall through.
            state.slots.lastName = state.auth.lastName;
          } else {
            reply = `I found PNR *${inputPnr}*. Please enter the passenger's last name to authorize rescheduling.`;
            await sessionService.updateSessionState(sessionId, state);
            logger.logMessage('OUTBOUND', userId, reply, state.slots.pnr);
            return { reply, sessionState: state, agentHandoff: false };
          }
        } else {
          reply = "Invalid PNR format. Please enter your PNR in the format BW1234 (e.g., BW9001).";
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply);
          return { reply, sessionState: state, agentHandoff: false };
        }
      }

      // 2. Collect Last Name & Verify
      if (state.slots.pnr && !state.slots.lastName) {
        const inputLastName = message.trim();
        if (inputLastName.length > 0) {
          state.slots.lastName = inputLastName;
        } else {
          reply = "Please enter a valid passenger last name.";
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply);
          return { reply, sessionState: state, agentHandoff: false };
        }
      }

      // 3. Authenticate & Ask for new date
      if (state.step === 2 && state.slots.pnr && state.slots.lastName) {
        const statusResult = await bookingService.checkBookingStatus(state.slots.pnr, state.slots.lastName);
        if (!statusResult) {
          reply = `We couldn't find any booking with PNR *${state.slots.pnr}*. Please start over by typing 'reschedule'.`;
          state.currentFlow = null;
          state.slots = {};
        } else if (statusResult.matchError) {
          reply = `The passenger last name did not match our records for PNR *${state.slots.pnr}*. Please start over by typing 'reschedule'.`;
          state.currentFlow = null;
          state.slots = {};
        } else {
          const b = statusResult.booking;
          // Remember the verified identity for the rest of the session (no re-auth for this PNR).
          state.auth = { pnr: b.pnr, lastName: state.slots.lastName, verified: true };
          if (b.status === 'CANCELLED') {
            reply = `Cannot reschedule a cancelled booking. PNR *${b.pnr}* is already cancelled.`;
            state.currentFlow = null;
            state.slots = {};
          } else {
            reply = `We verified your booking for *${b.passengerName}* on flight *${b.flightNumber}* (${b.origin} ➔ ${b.destination}).\n\n` +
                    `What new date would you like to travel? (Use format *YYYY-MM-DD*, e.g., 2026-07-03).`;
            state.step = 3;
            // Save origin and destination for searching
            state.slots.origin = b.origin;
            state.slots.destination = b.destination;
          }
        }
        await sessionService.updateSessionState(sessionId, state);
        logger.logMessage('OUTBOUND', userId, reply, state.slots.pnr, state.slots.lastName);
        return { reply, sessionState: state, agentHandoff: false };
      }

      // 4. Collect Date & Show Alternatives
      if (state.step === 3) {
        const inputDate = message.trim();
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(inputDate)) {
          reply = "Invalid date format. Please specify the date in *YYYY-MM-DD* format (e.g., 2026-07-03).";
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply);
          return { reply, sessionState: state, agentHandoff: false };
        }

        try {
          const flights = await bookingService.searchFlights(state.slots.origin!, state.slots.destination!, inputDate);
          
          if (flights.length === 0) {
            const range = await bookingService.routeDateRange(state.slots.origin!, state.slots.destination!);
            const hint = range
              ? `Flights on this route are currently available between *${ymdIST(range.first)}* and *${ymdIST(range.last)}*. `
              : '';
            reply = `We couldn't find any alternative flights from ${state.slots.origin} to ${state.slots.destination} on *${inputDate}*.\n\n` +
                    hint +
                    `Please enter another date (YYYY-MM-DD) or type 'reschedule' to start over.`;
          } else {
            // Keep up to 3 flights
            const flightOptions = flights.slice(0, 3);
            state.slots.availableFlights = flightOptions.map(f => ({
              id: f.id,
              flightNumber: f.flightNumber,
              departureTime: f.departureTime,
              price: f.price
            }));

            let optionsText = `Here are the available flights from ${state.slots.origin} to ${state.slots.destination} on *${inputDate}*:\n\n`;
            flightOptions.forEach((f, idx) => {
              const depTime = new Date(f.departureTime).toLocaleTimeString('en-IN', { 
                timeZone: 'Asia/Kolkata', 
                hour: '2-digit', 
                minute: '2-digit' 
              });
              optionsText += `*${idx + 1}. ${f.flightNumber}* | Departs: ${depTime} | Price: Rs. ${f.price}\n`;
            });
            optionsText += `\nPlease reply with the flight number you wish to choose (e.g., *${flightOptions[0].flightNumber}*).`;
            
            reply = optionsText;
            state.step = 4;
            state.slots.newDate = inputDate;
          }
        } catch (err) {
          reply = "There was an error parsing the date. Please enter a valid date in YYYY-MM-DD format.";
        }
        await sessionService.updateSessionState(sessionId, state);
        logger.logMessage('OUTBOUND', userId, reply, state.slots.pnr, state.slots.lastName);
        return { reply, sessionState: state, agentHandoff: false };
      }

      // 5. Select Flight & Confirm
      if (state.step === 4) {
        const inputFlightNum = message.toUpperCase().trim().replace(/\s+/g, '');
        const available: any[] = state.slots.availableFlights || [];
        const chosenFlight = available.find(f => f.flightNumber.toUpperCase() === inputFlightNum);

        if (!chosenFlight) {
          reply = `Invalid selection. Please type one of the listed flight numbers (e.g., *${available[0]?.flightNumber || 'BW100'}*).`;
        } else {
          // Perform Reschedule Mutation in Transaction
          const updatedBooking = await bookingService.rescheduleBooking(state.slots.pnr!, chosenFlight.id);
          const depTime = new Date(chosenFlight.departureTime).toLocaleString('en-IN', { 
            timeZone: 'Asia/Kolkata', 
            dateStyle: 'medium', 
            timeStyle: 'short' 
          });
          
          reply = `🔄 *Flight Rescheduled Successfully*\n\n` +
                  `Your booking *${updatedBooking.pnr}* has been updated:\n` +
                  `• *Passenger*: ${updatedBooking.passenger.name}\n` +
                  `• *New Flight*: ${chosenFlight.flightNumber} (${state.slots.origin} ➔ ${state.slots.destination})\n` +
                  `• *Departure*: ${depTime}\n` +
                  `• *Status*: RESCHEDULED\n\n` +
                  `Your updated e-ticket is ready below. Is there anything else I can do for you?`;

          ticketUrl = buildTicketUrl(updatedBooking.pnr, state.slots.lastName!);
          state.currentFlow = null;
          state.slots = {};
        }
      }
    }

    else if (state.currentFlow === 'BOOK') {
      const airportRegex = /^[A-Z]{3}$/;

      // 1. Collect origin airport
      if (state.step === 1) {
        const code = resolveAirportCode(message);
        if (!airportRegex.test(code)) {
          reply = "Please enter a valid departure city (e.g., Mumbai, Delhi) or its 3-letter airport code (e.g., BOM, DEL).";
        } else if ((await bookingService.listDestinations(code)).length === 0) {
          const origins = await bookingService.listOrigins();
          reply = `Sorry, BlueWings doesn't operate from *${code}* right now. ✈️\n\n` +
                  `We currently fly from: *${origins.join(', ')}*.\n` +
                  `Please enter one of these cities or airport codes.`;
        } else {
          state.slots.origin = code;
          state.step = 2;
          reply = `Flying from *${code}*. Which city are you flying *to*? Reply with the city name or its 3-letter airport code.`;
        }
        await sessionService.updateSessionState(sessionId, state);
        logger.logMessage('OUTBOUND', userId, reply);
        return { reply, sessionState: state, agentHandoff: false };
      }

      // 2. Collect destination airport
      if (state.step === 2) {
        const code = resolveAirportCode(message);
        if (!airportRegex.test(code)) {
          reply = "Please enter a valid destination city (e.g., Bangalore, Chennai) or its 3-letter airport code (e.g., BLR, MAA).";
        } else if (code === state.slots.origin) {
          reply = "Destination must be different from your departure city. Please enter a different city or airport code.";
        } else {
          const destinations = await bookingService.listDestinations(state.slots.origin!);
          if (!destinations.includes(code)) {
            // Catch unserved routes here, instead of an endless "try another date" loop later.
            reply = `Sorry, BlueWings doesn't fly *${state.slots.origin} ➔ ${code}* right now. ✈️\n\n` +
                    `From *${state.slots.origin}* we currently serve: *${destinations.join(', ')}*.\n` +
                    `Please choose one of these destinations.`;
          } else {
            state.slots.destination = code;
            state.step = 3;
            reply = `Great, *${state.slots.origin} ➔ ${code}*. What date would you like to fly? (Use format *YYYY-MM-DD*, e.g., 2026-07-05).`;
          }
        }
        await sessionService.updateSessionState(sessionId, state);
        logger.logMessage('OUTBOUND', userId, reply);
        return { reply, sessionState: state, agentHandoff: false };
      }

      // 3. Collect date and show flight options
      if (state.step === 3) {
        const inputDate = message.trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(inputDate)) {
          reply = "Invalid date format. Please specify the date in *YYYY-MM-DD* format (e.g., 2026-07-05).";
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply);
          return { reply, sessionState: state, agentHandoff: false };
        }

        reply = await presentFlightOptionsForDate(state, inputDate);
        await sessionService.updateSessionState(sessionId, state);
        logger.logMessage('OUTBOUND', userId, reply);
        return { reply, sessionState: state, agentHandoff: false };
      }

      // 4. Select a flight
      if (state.step === 4) {
        const inputFlightNum = message.toUpperCase().trim().replace(/\s+/g, '');
        const available: any[] = state.slots.availableFlights || [];
        const chosen = available.find(f => f.flightNumber.toUpperCase() === inputFlightNum);
        if (!chosen) {
          reply = `Invalid selection. Please type one of the listed flight numbers (e.g., *${available[0]?.flightNumber || 'BW100'}*).`;
        } else {
          state.slots.selectedFlightId = chosen.id;
          state.slots.selectedFlightNumber = chosen.flightNumber;
          state.slots.price = chosen.price;
          state.step = 5;
          reply = `You selected *${chosen.flightNumber}* (Rs. ${chosen.price}).\n\nTo complete the booking, please enter the passenger's *full name*.`;
        }
        await sessionService.updateSessionState(sessionId, state);
        logger.logMessage('OUTBOUND', userId, reply);
        return { reply, sessionState: state, agentHandoff: false };
      }

      // 5. Collect passenger full name
      if (state.step === 5) {
        const name = message.trim();
        if (name.length < 2) {
          reply = "Please enter a valid passenger full name.";
        } else {
          state.slots.passengerName = name;
          state.step = 6;
          reply = "Thanks! Please enter the passenger's *email address*.";
        }
        await sessionService.updateSessionState(sessionId, state);
        logger.logMessage('OUTBOUND', userId, reply);
        return { reply, sessionState: state, agentHandoff: false };
      }

      // 6. Collect email
      if (state.step === 6) {
        const email = message.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          reply = "That doesn't look like a valid email. Please enter a valid email address (e.g., name@example.com).";
        } else {
          state.slots.email = email;
          state.step = 7;
          reply = "Almost done! Please enter the passenger's *phone number* (with country code, e.g., +919999999999).";
        }
        await sessionService.updateSessionState(sessionId, state);
        logger.logMessage('OUTBOUND', userId, reply);
        return { reply, sessionState: state, agentHandoff: false };
      }

      // 7. Collect phone and transition to seat selection
      if (state.step === 7) {
        const phone = message.trim().replace(/\s+/g, '');
        if (!/^\+?\d{7,15}$/.test(phone)) {
          reply = "Please enter a valid phone number (7-15 digits, optional leading +, e.g., +919999999999).";
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply);
          return { reply, sessionState: state, agentHandoff: false };
        }

        state.slots.phone = phone;
        state.step = 8;

        // Fetch occupied seats for this flight
        const occupiedBookings = await prisma.booking.findMany({
          where: {
            flightId: state.slots.selectedFlightId,
            status: { not: 'CANCELLED' },
            seatNumber: { not: null }
          },
          select: { seatNumber: true }
        });
        const occupiedSeats = new Set(occupiedBookings.map(b => b.seatNumber as string));

        // Generate seat map and available seats list
        const { seatMapText, availableSeats } = generateSeatMap(occupiedSeats);
        state.slots.availableSeatList = availableSeats; // save for suggestions and validation

        reply = `Thanks! Now, let's select your seat. Here is the seat map for Flight *${state.slots.selectedFlightNumber}*:\n\n` +
                `${seatMapText}\n\n` +
                `*Available Seats*:\n` +
                `${availableSeats.join(', ')}\n\n` +
                `Reply with the seat number you'd like to book (e.g., *3A*).`;

        await sessionService.updateSessionState(sessionId, state);
        logger.logMessage('OUTBOUND', userId, reply);
        return { reply, sessionState: state, agentHandoff: false };
      }

      // 8. Seat Selection and Payment
      if (state.step === 8) {
        const input = message.trim().toUpperCase();

        // Check if we are in a payment retry path (input is a phone number, and a seat is already selected)
        const isPhoneRetry = /^\+?\d{7,15}$/.test(input.replace(/\s+/g, '')) && state.slots.seatNumber;
        
        let seat = state.slots.seatNumber;
        let phone = state.slots.phone;

        if (isPhoneRetry) {
          phone = input.replace(/\s+/g, '');
          state.slots.phone = phone;
        } else {
          // Validate seat selection
          const available: string[] = state.slots.availableSeatList || [];
          if (!available.includes(input)) {
            reply = `Invalid or occupied seat. Please reply with one of the available seats listed:\n\n${available.join(', ')}`;
            await sessionService.updateSessionState(sessionId, state);
            logger.logMessage('OUTBOUND', userId, reply);
            return { reply, sessionState: state, agentHandoff: false };
          }
          seat = input;
          state.slots.seatNumber = seat;
        }

        // Calculate price adjustment based on seat category
        // Premium (Rows 1-2): +Rs. 800
        // Window (Row 3-5, A/F): +Rs. 300
        // Aisle (Row 3-5, C/D): +Rs. 200
        // Middle (Row 3-5, B/E): +Rs. 0
        const row = parseInt(seat.charAt(0), 10);
        const col = seat.charAt(1);
        let adjustment = 0;
        let category = 'Standard Middle';

        if (row <= 2) {
          adjustment = 800;
          category = 'Premium';
        } else {
          if (col === 'A' || col === 'F') {
            adjustment = 300;
            category = 'Standard Window';
          } else if (col === 'C' || col === 'D') {
            adjustment = 200;
            category = 'Standard Aisle';
          } else {
            adjustment = 0;
            category = 'Standard Middle';
          }
        }

        const basePrice = state.slots.price || 0;
        const totalPrice = basePrice + adjustment;
        state.slots.totalPrice = totalPrice;

        // Process simulated payment
        const payment = await paymentService.processPayment(totalPrice, {
          simulateFailure: phone.endsWith('0000')
        });

        if (!payment.success) {
          reply = `❌ *Payment Declined*\n\n${payment.failureReason || 'The payment could not be processed.'}\n\n` +
                  `No money was taken. We have saved your seat selection *${seat}*. Please enter a different phone number to retry payment, ` +
                  `or type 'agent' for assistance.`;
        } else {
          const booking = await bookingService.createBooking(
            state.slots.selectedFlightId!,
            {
              name: state.slots.passengerName!,
              email: state.slots.email!,
              phone
            },
            seat,
            totalPrice
          );

          state.auth = {
            pnr: booking.pnr,
            lastName: state.slots.passengerName!.trim().split(/\s+/).pop(),
            verified: true
          };

          const depTime = new Date(booking.flight.departureTime).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
          });

          reply = `✅ *Booking Confirmed!*\n\n` +
                  `• *PNR*: ${booking.pnr}\n` +
                  `• *Passenger*: ${booking.passenger.name}\n` +
                  `• *Flight*: ${booking.flight.flightNumber} (${booking.flight.origin} ➔ ${booking.flight.destination})\n` +
                  `• *Departure*: ${depTime}\n` +
                  `• *Seat*: ${seat} (${category})\n` +
                  `• *Amount Paid*: Rs. ${totalPrice} (Base: Rs. ${basePrice} + Seat: Rs. ${adjustment})\n` +
                  `• *Payment Ref*: ${payment.transactionId}\n\n` +
                  `Your e-ticket is ready below. 🎫 Keep your PNR *${booking.pnr}* handy to check status, reschedule, or cancel. Safe travels! ✈️`;
          
          ticketUrl = buildTicketUrl(booking.pnr, state.auth.lastName!);
          state.currentFlow = null;
          state.slots = {};
        }
      }
    }

    else if (state.currentFlow === 'TRIPS') {
      // 1. Collect any of the passenger's PNRs
      if (!state.slots.pnr) {
        const inputPnr = message.toUpperCase().replace(/\s+/g, '');
        if (/^BW\d{4}$/.test(inputPnr)) {
          state.slots.pnr = inputPnr;
          state.step = 2;
          if (isSessionVerifiedFor(state, inputPnr)) {
            state.slots.lastName = state.auth.lastName;
          } else {
            reply = `I found PNR *${inputPnr}*. Please enter the passenger's last name to verify your identity.`;
            await sessionService.updateSessionState(sessionId, state);
            logger.logMessage('OUTBOUND', userId, reply, state.slots.pnr);
            return { reply, sessionState: state, agentHandoff: false };
          }
        } else {
          reply = "Invalid PNR format. Please enter any of your PNRs in the format BW1234 (e.g., BW9001).";
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply);
          return { reply, sessionState: state, agentHandoff: false };
        }
      }

      // 2. Collect Last Name
      if (state.slots.pnr && !state.slots.lastName) {
        const inputLastName = message.trim();
        if (inputLastName.length > 0) {
          state.slots.lastName = inputLastName;
        } else {
          reply = "Please enter a valid passenger last name.";
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply);
          return { reply, sessionState: state, agentHandoff: false };
        }
      }

      // 3. Verify and list all trips
      if (state.slots.pnr && state.slots.lastName) {
        const statusResult = await bookingService.checkBookingStatus(state.slots.pnr, state.slots.lastName);
        if (!statusResult) {
          reply = `We couldn't find any booking with PNR *${state.slots.pnr}*. Please start over by typing 'my trips'.`;
        } else if (statusResult.matchError) {
          reply = `The passenger last name did not match our records for PNR *${state.slots.pnr}*. Please start over by typing 'my trips'.`;
        } else {
          state.auth = { pnr: state.slots.pnr, lastName: state.slots.lastName, verified: true };
          reply = await buildTripsReply(state.slots.pnr);
        }
        state.currentFlow = null;
        state.slots = {};
      }
    }

    else {
      // Not in an active flow, handle initial intent
      if (intent === 'CHECK_STATUS') {
        state.currentFlow = 'CHECK_STATUS';

        if (parsed.slots.pnr) {
          state.slots.pnr = parsed.slots.pnr;
        }

        if (isSessionVerifiedFor(state, state.slots.pnr)) {
          // Verified earlier this session — skip re-auth and re-enter the state
          // machine so the answer comes back in this same turn.
          state.slots.lastName = state.auth.lastName;
          state.step = 2;
          await sessionService.updateSessionState(sessionId, state);
          return processCore(payload);
        }

        if (!state.slots.pnr) {
          reply = "Sure! I can help check your booking status. Please enter your 6-character PNR (booking reference, e.g., BW9001).";
          state.step = 1;
        } else {
          reply = `I found PNR *${state.slots.pnr}* in your request. Please enter the passenger's last name to verify your identity.`;
          state.step = 2;
        }
      } 
      
      else if (intent === 'CANCEL') {
        state.currentFlow = 'CANCEL';
        if (parsed.slots.pnr) {
          state.slots.pnr = parsed.slots.pnr;
          if (isSessionVerifiedFor(state, state.slots.pnr)) {
            // Verified earlier this session — skip re-auth and re-enter the state
            // machine so the confirmation prompt comes back in this same turn.
            state.slots.lastName = state.auth.lastName;
            state.step = 2;
            await sessionService.updateSessionState(sessionId, state);
            return processCore(payload);
          }
          reply = `I found PNR *${state.slots.pnr}* in your request. Please enter the passenger's last name to verify your identity for cancellation.`;
          state.step = 2;
        } else {
          reply = "Sure! I can help you cancel your flight. Please enter your 6-character PNR (booking reference, e.g., BW9001).";
          state.step = 1;
        }
      } 
      
      else if (intent === 'RESCHEDULE') {
        state.currentFlow = 'RESCHEDULE';
        if (parsed.slots.pnr) {
          state.slots.pnr = parsed.slots.pnr;
          if (isSessionVerifiedFor(state, state.slots.pnr)) {
            // Verified earlier this session — skip re-auth and re-enter the state
            // machine so the date prompt comes back in this same turn.
            state.slots.lastName = state.auth.lastName;
            state.step = 2;
            await sessionService.updateSessionState(sessionId, state);
            return processCore(payload);
          }
          reply = `I found PNR *${state.slots.pnr}* in your request. Please enter the passenger's last name to verify your identity for rescheduling.`;
          state.step = 2;
        } else {
          reply = "Sure! I can help you reschedule your flight. Please enter your 6-character PNR (booking reference, e.g., BW9001).";
          state.step = 1;
        }
      }
      
      else if (intent === 'MY_TRIPS') {
        if (state.auth.verified && state.auth.pnr) {
          // Already verified this session — answer immediately.
          reply = await buildTripsReply(state.auth.pnr);
        } else {
          state.currentFlow = 'TRIPS';
          if (parsed.slots.pnr) {
            state.slots.pnr = parsed.slots.pnr;
            state.step = 2;
            reply = `I found PNR *${state.slots.pnr}* in your request. Please enter the passenger's last name to verify your identity.`;
          } else {
            state.step = 1;
            reply = "Happy to show your trips! 🧳 Please enter any of your PNRs (booking reference, e.g., BW9001) so I can verify you.";
          }
        }
      }

      else if (intent === 'BOOK') {
        state.currentFlow = 'BOOK';

        // One-message booking: pre-fill any origin/destination/date the intent
        // parser extracted ("book mumbai to delhi on 2026-07-06"), validating
        // each against served routes. Invalid slots are silently dropped — the
        // flow simply asks for them step by step as usual.
        if (parsed.slots.origin) {
          const code = resolveAirportCode(String(parsed.slots.origin));
          if (/^[A-Z]{3}$/.test(code) && (await bookingService.listDestinations(code)).length > 0) {
            state.slots.origin = code;
          }
        }
        if (state.slots.origin && parsed.slots.destination) {
          const code = resolveAirportCode(String(parsed.slots.destination));
          const served = await bookingService.listDestinations(state.slots.origin);
          if (/^[A-Z]{3}$/.test(code) && code !== state.slots.origin && served.includes(code)) {
            state.slots.destination = code;
          }
        }

        if (!state.slots.origin) {
          state.step = 1;
          reply = "Great, let's book a new flight! ✈️\n\nWhich city are you flying *from*? Please reply with the city name (e.g., Mumbai, Delhi) or its 3-letter airport code (e.g., BOM, DEL).";
        } else if (!state.slots.destination) {
          state.step = 2;
          reply = `Great, let's book a new flight! ✈️ Flying from *${state.slots.origin}*.\n\nWhich city are you flying *to*? Reply with the city name or its 3-letter airport code.`;
        } else if (parsed.slots.date && /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.slots.date))) {
          state.step = 3;
          reply = await presentFlightOptionsForDate(state, String(parsed.slots.date));
        } else {
          state.step = 3;
          reply = `Great, *${state.slots.origin} ➔ ${state.slots.destination}*. What date would you like to fly? (Use format *YYYY-MM-DD*, e.g., 2026-07-05).`;
        }
      }

      else {
        reply = "Hello! I am your BlueWings Airlines assistant. ✈️\n\n" + MENU_TEXT;
      }
    }

    // 6. Save updated session state and return response
    await sessionService.updateSessionState(sessionId, state);
    logger.logMessage('OUTBOUND', userId, reply, state.slots.pnr, state.slots.lastName);

    return { reply, sessionState: state, agentHandoff, ticketUrl };

  } catch (error: any) {
    // The bot must never go silent: any unexpected failure gets a friendly reply.
    logger.error('Error processing message', error);
    return {
      reply: "Sorry, something went wrong on our end. Please try again in a moment, or type 'agent' to reach a representative.",
      sessionState: { currentFlow: null, step: 0, slots: {}, auth: { verified: false }, consecutiveFailedParses: 0 },
      agentHandoff: false
    };
  }
}
