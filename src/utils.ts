/**
 * Formats a USD amount with appropriate suffix (K, M, B, T) based on magnitude
 * @param amount - The USD amount to format
 * @param precision - Number of decimal places to include (default: 2)
 * @returns Formatted USD amount as a string with appropriate suffix
 */
export const formatUsdAmount = (amount: number, precision = 2) => {
  if (amount === 0) return "$0";
  if (+amount.toFixed(precision) === 0) return "<$0.01";

  if (amount / 1000 < 1) return `$${amount.toFixed(precision)}`;

  if (amount / 1e6 < 1) return `$${(amount / 1000).toFixed(precision)}K`;

  if (amount / 1e9 < 1) return `$${(amount / 1e6).toFixed(precision)}M`;

  if (amount / 1e12 < 1) return `$${(amount / 1e9).toFixed(precision)}B`;

  return `$${(amount / 1e12).toFixed(precision)}T`;
};

/**
 * Returns the current Unix timestamp in seconds
 * @returns Current timestamp in seconds
 */
export function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}
