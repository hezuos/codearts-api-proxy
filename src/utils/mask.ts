/**
 * Mask a sensitive value for safe logging.
 * Shows first 6 and last 4 chars for long values, first 2 + *** for short values.
 */
export function maskValue(value: string | undefined): string {
  if (!value) {
    return "missing";
  }

  if (value.length <= 8) {
    return `${value.slice(0, 2)}***`;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}
