'use client';

import React from 'react';

export interface MessageBubbleProps {
  role: 'user' | 'bot';
  text: string;
  time: string;
}

/** Render WhatsApp-style *bold* spans without dangerouslySetInnerHTML. */
function renderWhatsAppText(text: string): React.ReactNode[] {
  const parts = text.split(/(\*[^*\n]+\*)/g);
  return parts.map((part, i) => {
    if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) {
      return <strong key={i}>{part.slice(1, -1)}</strong>;
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

export default function MessageBubble({ role, text, time }: MessageBubbleProps) {
  return (
    <div className={`bubble-row ${role}`}>
      {role === 'bot' && (
        <div className="bot-avatar" aria-hidden="true">
          ✈️
        </div>
      )}
      <div className={`bubble ${role}`}>
        <span>{renderWhatsAppText(text)}</span>
        <span className="time">{time}</span>
      </div>
    </div>
  );
}
