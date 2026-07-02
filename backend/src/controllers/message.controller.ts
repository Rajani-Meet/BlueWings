import { Request, Response } from 'express';
import { MessagePayloadSchema } from '../models/message.schema';
import { logger } from '../utils/logger';
import { sessionService, SessionState } from '../services/session.service';
import { parseIntent } from '../services/intentRouter.service';
import { bookingService } from '../services/booking.service';
import { agentHandoffService } from '../services/agentHandoff.service';
import { paymentService } from '../services/payment.service';

export async function handleMessage(req: Request, res: Response) {
  try {
    // Validate request body
    const payload = MessagePayloadSchema.parse(req.body);
    const { channel, userId, message } = payload;

    // 1. Get or create session
    const session = await sessionService.getOrCreateSession(channel, userId);
    const sessionId = session.id;
    let state = session.state;

    logger.logMessage('INBOUND', userId, message, state.slots.pnr, state.slots.lastName);

    // 2. Check if agent handoff is active
    if (session.agentHandoffActive) {
      const handoffReply = "An agent has been requested. Connecting you to a BlueWings representative shortly...";
      logger.logMessage('OUTBOUND', userId, handoffReply);
      return res.json({
        reply: handoffReply,
        sessionState: state,
        agentHandoff: true
      });
    }

    let reply = '';
    let agentHandoff = false;

    // 3. Parse intent and slots from the user message
    const parsed = await parseIntent(message);
    const intent = parsed.intent;

    // Handle consecutive failed intent parses (max 2 before handoff)
    if (intent === 'UNKNOWN' && state.currentFlow === null) {
      state.consecutiveFailedParses += 1;
      if (state.consecutiveFailedParses >= 2) {
        await sessionService.setAgentHandoff(sessionId, true);
        reply = "I'm having trouble understanding your request. Connecting you to an agent for support...";
        logger.logMessage('OUTBOUND', userId, reply);
        state.consecutiveFailedParses = 0; // reset
        await sessionService.updateSessionState(sessionId, state);
        return res.json({
          reply,
          sessionState: state,
          agentHandoff: true
        });
      }
    } else {
      if (intent !== 'UNKNOWN') {
        state.consecutiveFailedParses = 0; // Reset on successful parse
      }
    }

    // 4. Handle Explicit Agent Handoff
    if (intent === 'AGENT_HANDOFF') {
      await sessionService.setAgentHandoff(sessionId, true);
      reply = "Understood. I am connecting you to a BlueWings customer service agent...";
      logger.logMessage('OUTBOUND', userId, reply);
      return res.json({
        reply,
        sessionState: state,
        agentHandoff: true
      });
    }

    // 5. Dialogue State Machine & Slot Filling
    // Check if we are currently mid-flow
    if (state.currentFlow === 'CHECK_STATUS') {
      // If we don't have a PNR, check if the input is a valid PNR
      if (!state.slots.pnr) {
        const inputPnr = message.toUpperCase().replace(/\s+/g, '');
        if (/^BW\d{4}$/.test(inputPnr)) {
          state.slots.pnr = inputPnr;
          reply = `I found PNR *${inputPnr}*. Please enter the passenger's last name to verify your identity.`;
          state.step = 2;
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply, state.slots.pnr);
          return res.json({ reply, sessionState: state, agentHandoff: false });
        } else {
          reply = "Invalid PNR format. Please enter your PNR in the format BW1234 (e.g., BW9001).";
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply);
          return res.json({ reply, sessionState: state, agentHandoff: false });
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
          return res.json({ reply, sessionState: state, agentHandoff: false });
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
          reply = `I found PNR *${inputPnr}*. Please enter the passenger's last name to authorize the cancellation.`;
          state.step = 2;
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply, state.slots.pnr);
          return res.json({ reply, sessionState: state, agentHandoff: false });
        } else {
          reply = "Invalid PNR format. Please enter your PNR in the format BW1234 (e.g., BW9001).";
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply);
          return res.json({ reply, sessionState: state, agentHandoff: false });
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
          return res.json({ reply, sessionState: state, agentHandoff: false });
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
        return res.json({ reply, sessionState: state, agentHandoff: false });
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
          reply = "I see you have concerns about the cancellation policy or refund fees. I am transferring you to a customer service agent to assist you immediately...";
          logger.logMessage('OUTBOUND', userId, reply);
          return res.json({ reply, sessionState: state, agentHandoff: true });
        }

        if (normalizedMsg === 'yes' || normalizedMsg === 'confirm') {
          const cancelResult = await bookingService.cancelBooking(state.slots.pnr!);
          const refundAmount = 4500; // Simulated refund
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
          reply = `I found PNR *${inputPnr}*. Please enter the passenger's last name to authorize rescheduling.`;
          state.step = 2;
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply, state.slots.pnr);
          return res.json({ reply, sessionState: state, agentHandoff: false });
        } else {
          reply = "Invalid PNR format. Please enter your PNR in the format BW1234 (e.g., BW9001).";
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply);
          return res.json({ reply, sessionState: state, agentHandoff: false });
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
          return res.json({ reply, sessionState: state, agentHandoff: false });
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
        return res.json({ reply, sessionState: state, agentHandoff: false });
      }

      // 4. Collect Date & Show Alternatives
      if (state.step === 3) {
        const inputDate = message.trim();
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(inputDate)) {
          reply = "Invalid date format. Please specify the date in *YYYY-MM-DD* format (e.g., 2026-07-03).";
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply);
          return res.json({ reply, sessionState: state, agentHandoff: false });
        }

        try {
          const flights = await bookingService.searchFlights(state.slots.origin!, state.slots.destination!, inputDate);
          
          if (flights.length === 0) {
            reply = `We couldn't find any alternative flights from ${state.slots.origin} to ${state.slots.destination} on *${inputDate}*.\n\n` +
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
        return res.json({ reply, sessionState: state, agentHandoff: false });
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
                  `Is there anything else I can do for you?`;
          
          state.currentFlow = null;
          state.slots = {};
        }
      }
    }

    else if (state.currentFlow === 'BOOK') {
      const airportRegex = /^[A-Z]{3}$/;

      // 1. Collect origin airport
      if (state.step === 1) {
        const code = message.trim().toUpperCase();
        if (!airportRegex.test(code)) {
          reply = "Please enter a valid 3-letter departure airport code (e.g., BOM, DEL, BLR).";
        } else {
          state.slots.origin = code;
          state.step = 2;
          reply = `Flying from *${code}*. Which city are you flying *to*? Reply with the 3-letter airport code.`;
        }
        await sessionService.updateSessionState(sessionId, state);
        logger.logMessage('OUTBOUND', userId, reply);
        return res.json({ reply, sessionState: state, agentHandoff: false });
      }

      // 2. Collect destination airport
      if (state.step === 2) {
        const code = message.trim().toUpperCase();
        if (!airportRegex.test(code)) {
          reply = "Please enter a valid 3-letter destination airport code (e.g., BOM, DEL, BLR).";
        } else if (code === state.slots.origin) {
          reply = "Destination must be different from your departure city. Please enter a different 3-letter airport code.";
        } else {
          state.slots.destination = code;
          state.step = 3;
          reply = `Great, *${state.slots.origin} ➔ ${code}*. What date would you like to fly? (Use format *YYYY-MM-DD*, e.g., 2026-07-05).`;
        }
        await sessionService.updateSessionState(sessionId, state);
        logger.logMessage('OUTBOUND', userId, reply);
        return res.json({ reply, sessionState: state, agentHandoff: false });
      }

      // 3. Collect date and show flight options
      if (state.step === 3) {
        const inputDate = message.trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(inputDate)) {
          reply = "Invalid date format. Please specify the date in *YYYY-MM-DD* format (e.g., 2026-07-05).";
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply);
          return res.json({ reply, sessionState: state, agentHandoff: false });
        }

        const flights = await bookingService.searchFlights(state.slots.origin!, state.slots.destination!, inputDate);
        if (flights.length === 0) {
          reply = `Sorry, no flights found from ${state.slots.origin} to ${state.slots.destination} on *${inputDate}*.\n\n` +
                  `Please try another date (YYYY-MM-DD), or type 'agent' to speak with a representative.`;
        } else {
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
          reply = optionsText;
          state.slots.date = inputDate;
          state.step = 4;
        }
        await sessionService.updateSessionState(sessionId, state);
        logger.logMessage('OUTBOUND', userId, reply);
        return res.json({ reply, sessionState: state, agentHandoff: false });
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
        return res.json({ reply, sessionState: state, agentHandoff: false });
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
        return res.json({ reply, sessionState: state, agentHandoff: false });
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
        return res.json({ reply, sessionState: state, agentHandoff: false });
      }

      // 7. Collect phone, simulate payment, create booking
      if (state.step === 7) {
        const phone = message.trim().replace(/\s+/g, '');
        if (!/^\+?\d{7,15}$/.test(phone)) {
          reply = "Please enter a valid phone number (7-15 digits, optional leading +, e.g., +919999999999).";
          await sessionService.updateSessionState(sessionId, state);
          logger.logMessage('OUTBOUND', userId, reply);
          return res.json({ reply, sessionState: state, agentHandoff: false });
        }

        // Simulated payment (always succeeds in this MVP)
        const payment = await paymentService.processPayment(state.slots.price || 0);
        if (!payment.success) {
          reply = "Payment could not be processed. Please try again later or type 'agent' for assistance.";
          state.currentFlow = null;
          state.slots = {};
        } else {
          const booking = await bookingService.createBooking(state.slots.selectedFlightId!, {
            name: state.slots.passengerName!,
            email: state.slots.email!,
            phone
          });
          const depTime = new Date(booking.flight.departureTime).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
          });
          reply = `✅ *Booking Confirmed!*\n\n` +
                  `• *PNR*: ${booking.pnr}\n` +
                  `• *Passenger*: ${booking.passenger.name}\n` +
                  `• *Flight*: ${booking.flight.flightNumber} (${booking.flight.origin} ➔ ${booking.flight.destination})\n` +
                  `• *Departure*: ${depTime}\n` +
                  `• *Amount Paid*: Rs. ${state.slots.price}\n` +
                  `• *Payment Ref*: ${payment.transactionId}\n\n` +
                  `Keep your PNR *${booking.pnr}* handy to check status, reschedule, or cancel. Safe travels! ✈️`;
          state.currentFlow = null;
          state.slots = {};
        }
      }
    }

    else {
      // Not in an active flow, handle initial intent
      if (intent === 'CHECK_STATUS') {
        state.currentFlow = 'CHECK_STATUS';
        
        if (parsed.slots.pnr) {
          state.slots.pnr = parsed.slots.pnr;
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
          reply = `I found PNR *${state.slots.pnr}* in your request. Please enter the passenger's last name to verify your identity for rescheduling.`;
          state.step = 2;
        } else {
          reply = "Sure! I can help you reschedule your flight. Please enter your 6-character PNR (booking reference, e.g., BW9001).";
          state.step = 1;
        }
      }
      
      else if (intent === 'BOOK') {
        state.currentFlow = 'BOOK';
        state.step = 1;
        reply = "Great, let's book a new flight! ✈️\n\nWhich city are you flying *from*? Please reply with the 3-letter airport code (e.g., BOM, DEL, BLR).";
      }

      else {
        reply = "Hello! I am your BlueWings Airlines assistant. ✈️\n\n" +
                  "How can I help you today? You can choose from:\n" +
                  "1. *Check booking status* (type 'status')\n" +
                  "2. *Book a new flight* (type 'book')\n" +
                  "3. *Reschedule flight* (type 'reschedule')\n" +
                  "4. *Cancel booking* (type 'cancel')\n" +
                  "5. *Talk to an agent* (type 'agent')";
      }
    }

    // 6. Save updated session state and return response
    await sessionService.updateSessionState(sessionId, state);
    logger.logMessage('OUTBOUND', userId, reply, state.slots.pnr, state.slots.lastName);

    res.json({
      reply,
      sessionState: state,
      agentHandoff
    });

  } catch (error: any) {
    logger.error('Error in message controller handler', error);
    res.status(400).json({ error: error.message || 'Error processing request' });
  }
}
