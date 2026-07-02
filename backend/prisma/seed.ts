import { PrismaClient, BookingStatus, Flight } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Cleaning up database...');
  await prisma.booking.deleteMany();
  await prisma.conversationSession.deleteMany();
  await prisma.flight.deleteMany();
  await prisma.passenger.deleteMany();

  console.log('Seeding flights...');
  // All ordered pairs of these airports get flights (30 routes).
  // BOM->DEL stays first so createdFlights[0] keeps backing demo PNR BW9001.
  const airports = ['BOM', 'DEL', 'BLR', 'AMD', 'HYD', 'MAA', 'CCU', 'PNQ', 'COK', 'JAI', 'GOI', 'LKO'];
  const routes: { origin: string; destination: string }[] = [];
  for (const origin of airports) {
    for (const destination of airports) {
      if (origin !== destination) routes.push({ origin, destination });
    }
  }


  const flightsData = [];
  const baseTime = new Date();
  baseTime.setHours(8, 0, 0, 0); // Start at 8 AM today

  let flightCounter = 100;
  // Seed flights for the next 7 days
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    for (const route of routes) {
      // 2 flights per route per day (morning and evening)
      for (const timing of ['morning', 'evening']) {
        const departureTime = new Date(baseTime);
        departureTime.setDate(baseTime.getDate() + dayOffset);
        if (timing === 'evening') {
          departureTime.setHours(18, 30, 0, 0);
        } else {
          departureTime.setHours(8, 15, 0, 0);
        }

        const arrivalTime = new Date(departureTime);
        arrivalTime.setHours(departureTime.getHours() + 2); // 2 hour duration
        arrivalTime.setMinutes(departureTime.getMinutes() + 15);

        flightCounter++;
        flightsData.push({
          flightNumber: `BW${flightCounter}`,
          origin: route.origin,
          destination: route.destination,
          departureTime,
          arrivalTime,
          price: 4500 + (flightCounter % 7) * 450 + (timing === 'evening' ? 500 : 0),
        });
      }
    }
  }

  const createdFlights: Flight[] = [];
  for (const f of flightsData) {
    const flight = await prisma.flight.create({ data: f });
    createdFlights.push(flight);
  }
  console.log(`Seeded ${createdFlights.length} flights.`);

  console.log('Seeding passengers...');
  const passengersData = [
    { name: 'John Doe', email: 'john.doe@example.com', phone: '+1234567890' },
    { name: 'Jane Smith', email: 'jane.smith@example.com', phone: '+1987654321' },
    { name: 'Rahul Kumar', email: 'rahul.kumar@example.com', phone: '+919999999999' },
    { name: 'Priya Sharma', email: 'priya.sharma@example.com', phone: '+918888888888' },
    { name: 'Alice Johnson', email: 'alice.j@example.com', phone: '+1555555555' },
  ];

  const createdPassengers = [];
  for (const p of passengersData) {
    const passenger = await prisma.passenger.create({ data: p });
    createdPassengers.push(passenger);
  }
  console.log(`Seeded ${createdPassengers.length} passengers.`);

  console.log('Seeding bookings...');
  // Demo bookings pick day-0 flights by route (created in day/route/timing order,
  // so the first match for a route is always day 0).
  const flightFor = (origin: string, destination: string, evening = false) =>
    createdFlights.find(
      (f) =>
        f.origin === origin &&
        f.destination === destination &&
        f.departureTime.getHours() === (evening ? 18 : 8)
    )!;

  const pnrs = ['BW9001', 'BW9002', 'BW9003', 'BW9004', 'BW9005'];
  const bookingsData = [
    {
      pnr: pnrs[0],
      passengerId: createdPassengers[0].id,
      flightId: flightFor('BOM', 'DEL').id, // day 0 morning
      status: BookingStatus.CONFIRMED,
    },
    {
      pnr: pnrs[1],
      passengerId: createdPassengers[1].id,
      flightId: flightFor('BLR', 'DEL').id, // day 0 morning
      status: BookingStatus.CONFIRMED,
    },
    {
      pnr: pnrs[2],
      passengerId: createdPassengers[2].id,
      flightId: flightFor('BOM', 'BLR').id, // day 0 morning
      status: BookingStatus.CONFIRMED,
    },
    {
      pnr: pnrs[3],
      passengerId: createdPassengers[3].id,
      flightId: flightFor('DEL', 'BOM', true).id, // day 0 evening
      status: BookingStatus.CONFIRMED,
    },
    {
      pnr: pnrs[4],
      passengerId: createdPassengers[4].id,
      flightId: flightFor('DEL', 'BLR', true).id, // day 0 evening
      status: BookingStatus.CANCELLED,
    },
  ];

  for (const b of bookingsData) {
    await prisma.booking.create({ data: b });
  }
  console.log(`Seeded ${bookingsData.length} bookings.`);

  console.log('Seeding completed successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
