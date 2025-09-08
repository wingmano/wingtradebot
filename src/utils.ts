export function calculateDurationInMinutes(openTime: number, closeTime: number): number {
  const open = new Date(openTime);
  const close = new Date(closeTime);
  const durationMs = close.getTime() - open.getTime();
  return Math.round(durationMs / (1000 * 60));
}

export function getTradingSessionForTimestamp(timestamp: number): string | null {
  if (!timestamp) return null;

  try {
    // Create a date object from the timestamp (which is in UTC)
    const date = new Date(timestamp);
    
    // Convert to ET (Eastern Time)
    // Note: This is a more accurate conversion that accounts for timezone offsets
    const etOffset = -5 * 60 * 60 * 1000; // UTC-5 for ET (adjust for DST if needed)
    const etDate = new Date(date.getTime() + etOffset);
    
    const hours = etDate.getUTCHours(); // Use UTC hours since we've already adjusted the time
    
    // Check which session the hour falls into
    if (hours >= 17 || hours < 1) {
      return "asia_session";
    } else if (hours >= 1 && hours < 6) {
      return "london_session";
    } else if (hours >= 6 && hours < 14) {
      return "new_york_session";
    } else if (hours >= 14 && hours < 17) {
      return "limbo_session";
    }
    
    return null; // Should never happen if times are defined correctly
  } catch (error) {
    console.error(`Error determining trading session for timestamp ${timestamp}:`, error);
    return null;
  }
}