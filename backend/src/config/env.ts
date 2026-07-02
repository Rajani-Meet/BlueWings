import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const env = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/bluewings?schema=public',

  // OpenRouter (OpenAI-compatible) — used for LLM intent parsing.
  // OPENROUTER_MODEL accepts a comma-separated list (max 3); OpenRouter routes to
  // the first available, which matters on free-tier models that rate-limit sporadically.
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-haiku',
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  OPENROUTER_APP_URL: process.env.OPENROUTER_APP_URL || 'http://localhost:3000',
  OPENROUTER_APP_TITLE: process.env.OPENROUTER_APP_TITLE || 'BlueWings Conversational Booking',
  LLM_TIMEOUT_MS: parseInt(process.env.LLM_TIMEOUT_MS || '9000', 10),

  WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN || '',
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || 'bluewings_verify_token_12345',
  NODE_ENV: process.env.NODE_ENV || 'development'
};
