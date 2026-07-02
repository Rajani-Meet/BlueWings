export const logger = {
  info: (message: string, ...args: any[]) => {
    console.log(`[INFO] ${new Date().toISOString()}: ${message}`, ...args);
  },
  error: (message: string, error?: any, ...args: any[]) => {
    console.error(`[ERROR] ${new Date().toISOString()}: ${message}`, error || '', ...args);
  },
  warn: (message: string, ...args: any[]) => {
    console.warn(`[WARN] ${new Date().toISOString()}: ${message}`, ...args);
  },
  logMessage: (
    direction: 'INBOUND' | 'OUTBOUND',
    conversationId: string,
    text: string,
    pnr?: string,
    lastName?: string
  ) => {
    const maskedLastName = lastName 
      ? lastName.charAt(0) + '*'.repeat(Math.max(0, lastName.length - 1)) 
      : undefined;
    
    // Mask in the text itself if there are PNR-like patterns or names
    let sanitizedText = text;
    if (pnr) {
      // If text contains the pnr and last name, mask the last name in the text
      if (lastName && text.includes(lastName)) {
        sanitizedText = sanitizedText.replace(new RegExp(lastName, 'gi'), maskedLastName || '');
      }
    }

    const details = pnr || maskedLastName 
      ? ` | PNR: ${pnr || 'N/A'}, LastName: ${maskedLastName || 'N/A'}` 
      : '';
    console.log(`[MSG][${direction}][Session: ${conversationId}] ${sanitizedText}${details}`);
  }
};
export default logger;
