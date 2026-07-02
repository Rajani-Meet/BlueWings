'use client';

import React from 'react';
import ChatWindow from '../components/ChatWindow';

export default function Home() {
  return (
    <main style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <ChatWindow />
    </main>
  );
}
