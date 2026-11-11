/**
 * What the API driver spent this month, in Tyto's durable records (`host.storage`, Tyto ADR
 * 0191), so a restart, an update or a wiped cache does not reset the cap.
 *
 * One record per month, `spend.YYYY-MM` in UTC, holding millionths of a US dollar. **A missing
 * record is zero spent**: a new month, a first run, or a plugin removed and installed again (which
 * deletes its records, ADR 0191 decision 3). **A record that cannot be read is not zero**: the
 * host refuses it, and the driver then treats the cap as reached until the person looks, rather
 * than spending as though the month were new.
 */

export interface Records {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** The month a turn is counted in: UTC, so it does not move with the computer's time zone. */
export function monthOf(now: Date): string {
  return now.toISOString().slice(0, 7);
}

export function ledgerKey(month: string): string {
  return `spend.${month}`;
}

/** Millionths of a dollar spent in `month`; throws when the record is there and unreadable. */
export async function spentIn(records: Records, month: string): Promise<number> {
  const stored = await records.get(ledgerKey(month));
  if (stored === undefined) return 0;
  const micros = (stored as { micros?: unknown } | null)?.micros;
  if (typeof micros !== 'number' || !Number.isFinite(micros) || micros < 0) {
    throw new Error(`the spend record for ${month} is not one this panel wrote`);
  }
  return micros;
}

/** Adds a call's cost to the month, and answers the month's new total. */
export async function addSpent(records: Records, month: string, micros: number): Promise<number> {
  const total = (await spentIn(records, month)) + micros;
  await records.set(ledgerKey(month), { micros: total });
  return total;
}
