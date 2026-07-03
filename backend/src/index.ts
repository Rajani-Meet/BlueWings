import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';
import messageRouter from './routes/message.route';
import whatsappRouter from './routes/whatsapp.route';
import ticketRouter from './routes/ticket.route';
import opsRouter from './routes/ops.route';
import { logger } from './utils/logger';

const app = express();

app.use(cors());
app.use(express.json());

// A chat user sends at most a few messages per minute; 30/min per IP absorbs
// bursts while blunting abuse. The reply is a friendly bot message, not a 429 wall.
const messageLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    reply: "You're sending messages a little too quickly. Please wait a moment and try again. 🙏",
    sessionState: null,
    agentHandoff: false
  }
});

// Routes
app.use('/api/message', messageLimiter, messageRouter);
app.use('/api/webhook/whatsapp', whatsappRouter);
app.use('/api/ticket', ticketRouter);
app.use('/api/ops', opsRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'BlueWings Conversational Booking API' });
});

app.listen(env.PORT, () => {
  logger.info(`Server is running on port ${env.PORT}`);
});

export default app;
