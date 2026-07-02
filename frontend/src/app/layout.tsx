import '../styles/globals.css';
import type { Metadata, Viewport } from 'next';
import SwRegister from '../components/SwRegister';


export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#0b2149',
};

export const metadata: Metadata = {
  title: 'BlueWings Airlines Chat',
  description: 'Manage and book your flights over chat',
  manifest: '/manifest.json',
};


export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body>
        <SwRegister />
        {children}
      </body>
    </html>
  );
}
