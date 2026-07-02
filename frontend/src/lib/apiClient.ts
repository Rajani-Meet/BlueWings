export async function sendMessage(channel: 'PWA' | 'WHATSAPP', userId: string, message: string) {
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
