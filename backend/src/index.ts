import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import messageRouter from './routes/message.route';
import whatsappRouter from './routes/whatsapp.route';
import { logger } from './utils/logger';

const app = express();

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/message', messageRouter);
app.use('/api/webhook/whatsapp', whatsappRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'BlueWings Conversational Booking API' });
});

app.listen(env.PORT, () => {
  logger.info(`Server is running on port ${env.PORT}`);
});

export default app;
