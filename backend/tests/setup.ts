// Runs before test modules are imported (vitest setupFiles).
import dotenv from 'dotenv';
import path from 'path';

// Load backend/.env so DATABASE_URL is available to Prisma under vitest.
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Force the deterministic keyword router: with no OpenRouter key configured,
// intentRouter falls back to keywords, keeping tests offline and reproducible.
process.env.OPENROUTER_API_KEY = '';
