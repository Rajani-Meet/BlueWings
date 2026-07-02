import { z } from 'zod';

export const MessagePayloadSchema = z.object({
  channel: z.enum(['WHATSAPP', 'PWA']),
  userId: z.string().min(1, 'userId is required'),
  message: z.string()
});

export type MessagePayload = z.infer<typeof MessagePayloadSchema>;

export const CheckStatusSlotsSchema = z.object({
  pnr: z.string().min(3).max(10),
  lastName: z.string().min(1)
});

export const BookFlightSlotsSchema = z.object({
  origin: z.string().length(3),
  destination: z.string().length(3),
  date: z.string(), // YYYY-MM-DD
  flightNumber: z.string().optional()
});

export const RescheduleSlotsSchema = z.object({
  pnr: z.string().min(3).max(10),
  newFlightNumber: z.string().optional()
});

export const CancelSlotsSchema = z.object({
  pnr: z.string().min(3).max(10)
});
