'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import MessageBubble from './MessageBubble';
import TypingIndicator from './TypingIndicator';
import { sendMessage } from '../lib/apiClient';

interface ChatItem {
  id: number;
  role: 'user' | 'bot' | 'system';
  text: string;
  time: string;
  suggestions?: string[];
  ticketUrl?: string;
}

const MENU_SUGGESTIONS = ['Check status', 'Book a flight', 'Reschedule', 'Cancel booking', 'Talk to an agent'];

/** Small icons for known quick-reply chips (unknown chips render text-only). */
const CHIP_ICONS: Record<string, string> = {
  'Check status': '🔎',
  'Book a flight': '✈️',
  'Reschedule': '📅',
  'Cancel booking': '🗑️',
  'Talk to an agent': '💬',
  'Back to menu': '↩️',
  'Yes': '✅',
  'No': '✖️',
};

const WELCOME_TEXT =
  'Hello! I am your BlueWings Airlines assistant. ✈️\n\n' +
  'How can I help you today? You can choose from:\n' +
  "1. *Check booking status* (type 'status')\n" +
  "2. *Book a new flight* (type 'book')\n" +
  "3. *Reschedule flight* (type 'reschedule')\n" +
  "4. *Cancel booking* (type 'cancel')\n" +
  "5. *Talk to an agent* (type 'agent')";

function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Stable per-browser user id so the backend keeps one conversation session. */
function getUserId(): string {
  const KEY = 'bluewings-user-id';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `web-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}

export default function ChatWindow() {
  // The welcome timestamp is set after mount: rendering nowTime() during SSR
  // causes a hydration mismatch (server and browser format times differently).
  const [items, setItems] = useState<ChatItem[]>([
    { id: 0, role: 'bot', text: WELCOME_TEXT, time: '', suggestions: MENU_SUGGESTIONS },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setItems(prev => prev.map(i => (i.id === 0 && !i.time ? { ...i, time: nowTime() } : i)));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [items, busy]);

  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    setInput('');
    setItems(prev => [...prev, { id: nextId.current++, role: 'user', text, time: nowTime() }]);
    setBusy(true);

    try {
      const res = await sendMessage('PWA', getUserId(), text);
      setItems(prev => [
        ...prev,
        { id: nextId.current++, role: 'bot', text: res.reply, time: nowTime(), suggestions: res.suggestions, ticketUrl: res.ticketUrl },
      ]);
      if (res.agentHandoff && !handoff) {
        setHandoff(true);
        setItems(prev => [
          ...prev,
          { id: nextId.current++, role: 'system', text: 'You have been placed in the agent queue 👩‍💼', time: nowTime() },
        ]);
      } else if (!res.agentHandoff && handoff) {
        setHandoff(false);
        setItems(prev => [
          ...prev,
          { id: nextId.current++, role: 'system', text: 'You are back with the automated assistant 🤖', time: nowTime() },
        ]);
      }
    } catch {
      setItems(prev => [
        ...prev,
        {
          id: nextId.current++,
          role: 'bot',
          text: "Sorry, I couldn't reach BlueWings right now. Please check your connection and try again.",
          time: nowTime(),
        },
      ]);
    } finally {
      setBusy(false);
    }
  }, [busy, handoff]);

  const submit = useCallback(() => send(input), [send, input]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  // Quick-reply chips from the latest bot message (hidden while a reply is pending).
  const lastItem = items[items.length - 1];
  const lastBot = [...items].reverse().find(i => i.role === 'bot');
  const suggestions =
    !busy && lastBot && lastItem.role !== 'user' ? lastBot.suggestions ?? [] : [];

  return (
    <div className="chat-shell">
      <header className="chat-header">
        <div className="route-deco" aria-hidden="true"><span>✈️</span></div>
        <div className="chat-avatar">✈️</div>
        <div>
          <div className="chat-title">BlueWings Airlines</div>
          <div className="chat-subtitle">Bookings · Reschedules · Cancellations</div>
        </div>
        <div className="status-pill">
          <span className={handoff ? 'status-dot busy' : 'status-dot'} />
          {handoff ? 'Agent requested…' : 'Online now'}
        </div>
      </header>

      <div className="chat-messages" ref={scrollRef}>
        {items.map(item =>
          item.role === 'system' ? (
            <div key={item.id} className="system-banner">{item.text}</div>
          ) : (
            <MessageBubble key={item.id} role={item.role} text={item.text} time={item.time} ticketUrl={item.ticketUrl} />
          )
        )}
        {busy && <TypingIndicator />}
      </div>

      {suggestions.length > 0 && (
        <div className="quick-replies">
          {suggestions.map(s => (
            <button key={s} className="quick-reply" onClick={() => void send(s)}>
              {CHIP_ICONS[s] && <span aria-hidden="true">{CHIP_ICONS[s]}</span>}
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="chat-composer">
        <textarea
          className="chat-input"
          rows={1}
          placeholder="Type a message"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Message"
        />
        <button className="send-btn" onClick={() => void submit()} disabled={busy || !input.trim()} aria-label="Send">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path
              d="M3.4 20.4 20.85 12.9c.83-.36.83-1.53 0-1.9L3.4 3.5c-.68-.3-1.43.2-1.43.94l-.01 4.63c0 .5.37.93.87.99L14 12 2.83 13.83c-.5.07-.87.5-.87 1l.01 4.63c0 .74.75 1.24 1.43.94Z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
