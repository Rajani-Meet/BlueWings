export interface BotResponse {
  reply: string;
  sessionState: unknown;
  agentHandoff: boolean;
  /** Quick-reply chips suggested by the backend for the next user turn. */
  suggestions?: string[];
}

export async function sendMessage(
  channel: 'PWA' | 'WHATSAPP',
  userId: string,
  message: string
): Promise<BotResponse> {
  const response = await fetch('/api/message', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ channel, userId, message })
  });
  if (!response.ok) {
    throw new Error('Network response was not ok');
  }
  return response.json();
}
