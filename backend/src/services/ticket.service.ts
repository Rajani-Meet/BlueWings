import PDFDocument from 'pdfkit';
import { Booking, Flight, Passenger } from '@prisma/client';
import { assignGate, assignSeat } from './booking.service';

/** Everything the PDF needs, derived once from a booking row + relations. */
export interface TicketData {
  pnr: string;
  status: string;
  passengerName: string;
  email: string;
  phone: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureTime: Date;
  arrivalTime: Date;
  gate: string;
  seat: string;
  fare: number;
  bookedAt: Date;
}

type BookingWithRelations = Booking & { passenger: Passenger; flight: Flight };

export function buildTicketData(booking: BookingWithRelations): TicketData {
  return {
    pnr: booking.pnr,
    status: booking.status,
    passengerName: booking.passenger.name,
    email: booking.passenger.email,
    phone: booking.passenger.phone,
    flightNumber: booking.flight.flightNumber,
    origin: booking.flight.origin,
    destination: booking.flight.destination,
    departureTime: booking.flight.departureTime,
    arrivalTime: booking.flight.arrivalTime,
    gate: assignGate(booking.pnr),
    seat: booking.seatNumber || assignSeat(booking.pnr),
    fare: booking.pricePaid || booking.flight.price,
    bookedAt: booking.createdAt
  };
}

// ---- brand palette (mirrors the PWA theme) ----
const NAVY = '#0B2149';
const BLUE = '#2158E8';
const SKY = '#38B6FF';
const AMBER = '#FFB02E';
const INK = '#17223B';
const MUTED = '#6B7A99';
const LINE = '#E4EAF6';

const IST = 'Asia/Kolkata';

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-IN', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtTime(d: Date): string {
  return d.toLocaleTimeString('en-IN', { timeZone: IST, hour: '2-digit', minute: '2-digit' });
}

/** Tiny deterministic PRNG so the decorative barcode is stable per PNR. */
function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

/** Renders the e-ticket to a Buffer (A4, single page). */
export function renderTicketPdf(t: TicketData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `BlueWings E-Ticket ${t.pnr}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width; // 595.28
    const M = 48; // side margin

    // ---- header band ----
    doc.rect(0, 0, W, 118).fill(NAVY);
    doc.font('Helvetica-Bold').fontSize(26).fillColor('#FFFFFF').text('BlueWings Airlines', M, 34);
    doc.font('Helvetica').fontSize(9.5).fillColor(SKY)
      .text('E-TICKET  ·  BOOKING CONFIRMATION', M, 68, { characterSpacing: 1.5 });

    // PNR chip on the right of the header
    doc.roundedRect(W - M - 150, 34, 150, 50, 8).fill('#12315F');
    doc.font('Helvetica').fontSize(8).fillColor(SKY).text('BOOKING REFERENCE (PNR)', W - M - 138, 44);
    doc.font('Helvetica-Bold').fontSize(19).fillColor('#FFFFFF').text(t.pnr, W - M - 138, 56);

    // runway strip
    const strip = doc.linearGradient(0, 118, W, 122);
    strip.stop(0, SKY).stop(0.45, BLUE).stop(1, AMBER);
    doc.rect(0, 118, W, 4).fill(strip);

    // ---- route section ----
    const routeY = 160;
    doc.font('Helvetica-Bold').fontSize(40).fillColor(NAVY).text(t.origin, M, routeY);
    doc.font('Helvetica-Bold').fontSize(40).fillColor(NAVY)
      .text(t.destination, W - M - 120, routeY, { width: 120, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
      .text('FROM', M, routeY + 44)
      .text('TO', W - M - 120, routeY + 44, { width: 120, align: 'right' });

    // flight path between the codes: dashed line + plane marker
    const lineY = routeY + 24;
    const x1 = M + 130;
    const x2 = W - M - 150;
    doc.moveTo(x1, lineY).lineTo(x2, lineY).dash(5, { space: 5 }).lineWidth(1.5).stroke('#C9D6F2');
    doc.undash();
    const mid = (x1 + x2) / 2;
    doc.circle(x1, lineY, 3.5).fill(BLUE);
    doc.circle(x2, lineY, 3.5).fill(AMBER);
    // simple plane silhouette at the middle
    doc.save().translate(mid, lineY).rotate(0)
      .path('M -10 0 L 4 -3 L 10 0 L 4 3 Z').fill(BLUE).restore();

    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
      .text(`Flight ${t.flightNumber}`, x1, lineY + 12, { width: x2 - x1, align: 'center' });
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED)
      .text(fmtDate(t.departureTime), x1, lineY + 27, { width: x2 - x1, align: 'center' });

    // ---- detail grid ----
    const gridY = 268;
    const cellW = (W - M * 2 - 24) / 3;
    const cell = (col: number, row: number, label: string, value: string, accent = INK) => {
      const x = M + col * (cellW + 12);
      const y = gridY + row * 74;
      doc.roundedRect(x, y, cellW, 62, 8).lineWidth(1).stroke(LINE);
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(label.toUpperCase(), x + 12, y + 12, { characterSpacing: 0.8 });
      const size = value.length > 18 ? 10 : 13; // long values (emails) stay on one line
      doc.font('Helvetica-Bold').fontSize(size).fillColor(accent).text(value, x + 12, y + 28, { width: cellW - 24, lineBreak: false });
    };

    cell(0, 0, 'Passenger', t.passengerName);
    cell(1, 0, 'Departure', `${fmtTime(t.departureTime)} IST`);
    cell(2, 0, 'Arrival', `${fmtTime(t.arrivalTime)} IST`);
    cell(0, 1, 'Terminal / Gate', t.gate);
    cell(1, 1, 'Seat', t.seat);
    cell(2, 1, 'Status', t.status, t.status === 'CANCELLED' ? '#C0392B' : '#1B8F5A');
    cell(0, 2, 'Fare Paid', `Rs. ${t.fare}`);
    cell(1, 2, 'Email', t.email);
    cell(2, 2, 'Phone', t.phone);

    // ---- perforation divider ----
    const perfY = gridY + 3 * 74 + 26;
    doc.moveTo(M - 10, perfY).lineTo(W - M + 10, perfY).dash(6, { space: 6 }).lineWidth(1.2).stroke('#C9D6F2');
    doc.undash();
    doc.circle(0, perfY, 9).fill('#FFFFFF');
    doc.circle(W, perfY, 9).fill('#FFFFFF');

    // ---- boarding stub: barcode + summary ----
    const stubY = perfY + 26;
    const rand = seededRandom(t.pnr + t.flightNumber);
    let bx = M;
    doc.save();
    while (bx < M + 220) {
      const bw = 1 + Math.floor(rand() * 3);
      if (rand() > 0.35) {
        doc.rect(bx, stubY, bw, 54).fill(NAVY);
      }
      bx += bw + 1 + Math.floor(rand() * 2);
    }
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY).text(t.pnr, M, stubY + 62, { characterSpacing: 4 });

    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
      .text('BOARDING SUMMARY', W - M - 220, stubY, { width: 220, align: 'right', characterSpacing: 1 });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
      .text(`${t.passengerName}  ·  ${t.flightNumber}`, W - M - 260, stubY + 16, { width: 260, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor(INK)
      .text(`${t.origin} to ${t.destination}  ·  ${fmtDate(t.departureTime)}  ·  ${fmtTime(t.departureTime)} IST`,
        W - M - 300, stubY + 34, { width: 300, align: 'right' })
      .text(`${t.gate}  ·  Seat ${t.seat}`, W - M - 300, stubY + 50, { width: 300, align: 'right' });

    // ---- footer ----
    const footY = stubY + 110;
    doc.rect(0, footY, W, doc.page.height - footY).fill('#F4F7FD');
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
      .text(
        'Please carry a valid government photo ID for check-in. Boarding gates close 25 minutes before departure. ' +
        'This e-ticket was issued by the BlueWings conversational assistant — simulated document for the MVP demo; not valid for travel.',
        M, footY + 18, { width: W - M * 2, lineGap: 3 }
      )
      .text(`Booked on ${fmtDate(t.bookedAt)} at ${fmtTime(t.bookedAt)} IST  ·  Generated ${new Date().toISOString()}`, M, footY + 52);

    doc.end();
  });
}
