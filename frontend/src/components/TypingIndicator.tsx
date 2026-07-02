'use client';

import React from 'react';

export default function TypingIndicator() {
  return (
    <div className="bubble-row bot">
      <div className="bot-avatar" aria-hidden="true">
        ✈️
      </div>
      <div className="typing-bubble" aria-label="BlueWings is typing">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
    </div>
  );
}
