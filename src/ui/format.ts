/** Shared UI formatting helpers. */

const KIB = 1024;
const MIB = 1024 * 1024;

/** Human-readable byte rate: B/s → KB/s → MB/s. */
export function formatRate(bytesPerSec: number): string {
  if (bytesPerSec >= MIB) return `${(bytesPerSec / MIB).toFixed(1)} MB/s`;
  if (bytesPerSec >= KIB) return `${(bytesPerSec / KIB).toFixed(1)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}
