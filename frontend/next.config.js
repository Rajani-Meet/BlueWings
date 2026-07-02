/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Proxy browser calls to /api/* through the Next server to the backend, so the
  // frontend needs no CORS setup and works identically in dev and Docker.
  // BACKEND_URL is http://backend:4000 in docker-compose, localhost in local dev.
  async rewrites() {
    const backend = process.env.BACKEND_URL || 'http://localhost:4000';
    return [
      {
        source: '/api/:path*',
        destination: `${backend}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
