// Runs before test modules are imported (vitest setupFiles).
// Force the deterministic keyword router: with no OpenRouter key configured,
// intentRouter falls back to keywords, keeping tests offline and reproducible.
process.env.OPENROUTER_API_KEY = '';
