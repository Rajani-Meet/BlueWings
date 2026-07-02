'use client';

import React from 'react';

export default function TypingIndicator() {
  return (
    <div className="bubble-row bot">
      <div className="typing-bubble" aria-label="BlueWings is typing">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
    </div>
  );
}
