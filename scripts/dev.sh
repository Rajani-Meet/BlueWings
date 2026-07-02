#!/bin/bash
# Start backend and frontend dev servers concurrently

echo "Starting BlueWings Conversational Booking MVP..."

# Trap CTRL+C and kill both background jobs
trap "kill 0" EXIT

# Start Backend
cd backend && npm run dev &
BACKEND_PID=$!

# Start Frontend
cd frontend && npm run dev &
FRONTEND_PID=$!

# Wait for both processes
wait $BACKEND_PID $FRONTEND_PID
