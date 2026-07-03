'use client';

import React from 'react';

export interface MessageBubbleProps {
  role: 'user' | 'bot';
  text: string;
  time: string;
  /** When set, renders a download button for the e-ticket PDF under the text. */
  ticketUrl?: string;
  imageUrl?: string;
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

export default function MessageBubble({ role, text, time, ticketUrl, imageUrl }: MessageBubbleProps) {
  return (
    <div className={`bubble-row ${role}`}>
      {role === 'bot' && (
        <div className="bot-avatar" aria-hidden="true">
          ✈️
        </div>
      )}
      <div className={`bubble ${role}`}>
        {imageUrl && (
          <img src={imageUrl} alt="Seat Map" style={{ maxWidth: '100%', borderRadius: 8, marginBottom: 8, display: 'block' }} />
        )}
        <span>{renderWhatsAppText(text)}</span>
        {ticketUrl && (
          <a className="ticket-btn" href={ticketUrl} download>
            <span className="ticket-btn-icon" aria-hidden="true">🎫</span>
            <span>
              Download e-ticket
              <small>PDF · boarding details inside</small>
            </span>
          </a>
        )}
        <span className="time">{time}</span>
      </div>
    </div>
  );
}
