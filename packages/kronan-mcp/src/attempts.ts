import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

import { SafeError } from '@family-mcp/mcp-runtime';
import {
  SessionStoreError,
  readPrivateFile,
  sweepTemp,
  withFileLock,
  writePrivateFile,
} from '@family-mcp/session-store';
import * as z from 'zod/v4';

import { tokenPath } from './auth.js';

/**
 * Local record of every charge-bearing request, so one approval produces at most one attempt even
 * across restarts and several MCP hosts. Only the CLI clears it; no MCP tool can.
 */
export const attemptsPath = () => `${tokenPath()}.order-attempts.json`;

const MAX_BYTES = 1_048_576;

/** Accepted records only guard their own checkout; unresolved records are never pruned. */
const ACCEPTED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const MONEY_TOOLS = [
  'reserve_delivery_slot',
  'reserve_pickup_slot',
  'complete_checkout',
  'add_checkout_to_order',
] as const;

export type MoneyTool = (typeof MONEY_TOOLS)[number];

/** An accepted call from these tools consumed the checkout contents for every money tool. */
const CONSUMING_TOOLS = new Set<MoneyTool>(['complete_checkout', 'add_checkout_to_order']);

const attemptSchema = z.object({
  id: z.string(),
  tool: z.enum(MONEY_TOOLS),
  checkoutToken: z.string(),
  fingerprint: z.string(),
  total: z.number().int(),
  state: z.enum(['submitting', 'accepted', 'unknown']),
  orderToken: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Attempt = z.infer<typeof attemptSchema>;

const attemptsFileSchema = z.object({ version: z.literal(1), attempts: z.array(attemptSchema) });

export const ATTEMPT_UNRESOLVED = new SafeError(
  'An earlier order call for this checkout is still unresolved (submitting or unknown). Nothing was sent to Krónan. Reconcile it with get_active_order and list_orders and ask the user what happened; this is not permission to retry.',
);

export const ATTEMPT_ACCEPTED = new SafeError(
  'Krónan already accepted this order call for this exact checkout (same lines and total). Nothing was sent to Krónan. Check get_active_order; a new order needs a changed checkout and a new approval.',
);

export const ATTEMPTS_BUSY = new SafeError(
  'Another Krónan order call is in progress, or the local order-attempt record cannot be locked. Nothing was sent to Krónan. Check get_active_order before anything else.',
);

export const ATTEMPT_RACED = new SafeError(
  'Another Krónan order call ran at the same time and changed the local order-attempt record. Nothing was sent to Krónan. Read get_active_order before anything else.',
);

export const ATTEMPTS_INVALID = new SafeError(
  'The local order-attempt record is unreadable or unsafe. Nothing was sent to Krónan. Check get_active_order and list_orders; the user can inspect the record with kronan-mcp orders clear-attempts.',
);

/** The checkout contents an approval covers: line SKUs and quantities, sorted, and the total. */
export function fingerprint(checkout: {
  total: number;
  lines: { quantity: number; product: { sku: string } }[];
}): string {
  const lines = checkout.lines
    .map((line) => `${line.product.sku}\u0000${line.quantity}`)
    .toSorted();

  return createHash('sha256')
    .update(JSON.stringify({ lines, total: checkout.total }))
    .digest('hex');
}

/** Returns the recorded attempts; a missing file has none, any other problem is an error. */
export async function readAttempts(path: string): Promise<Attempt[]> {
  let raw: string;

  try {
    raw = await readPrivateFile(path, { maxBytes: MAX_BYTES });
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === 'NOT_FOUND') return [];
    throw ATTEMPTS_INVALID;
  }

  try {
    return attemptsFileSchema.parse(JSON.parse(raw)).attempts;
  } catch {
    throw ATTEMPTS_INVALID;
  }
}

function writeAttempts(path: string, attempts: Attempt[]): Promise<void> {
  const cutoff = Date.now() - ACCEPTED_RETENTION_MS;

  const kept = attempts.filter(
    (attempt) => attempt.state !== 'accepted' || Date.parse(attempt.updatedAt) >= cutoff,
  );

  return writePrivateFile(path, JSON.stringify({ version: 1, attempts: kept }) + '\n');
}

/** Why a new attempt must not be sent, or undefined when it may. */
function blocker(
  attempts: Attempt[],
  tool: MoneyTool,
  checkoutToken: string,
  print?: string,
): SafeError | undefined {
  const sameCheckout = attempts.filter((attempt) => attempt.checkoutToken === checkoutToken);

  if (sameCheckout.some((attempt) => attempt.state !== 'accepted')) return ATTEMPT_UNRESOLVED;

  if (print === undefined) return undefined;

  // An accepted reserve still allows complete_checkout: the live reserve/complete sequence is unverified.
  const consumed = sameCheckout.some(
    (attempt) =>
      attempt.fingerprint === print && (attempt.tool === tool || CONSUMING_TOOLS.has(attempt.tool)),
  );

  return consumed ? ATTEMPT_ACCEPTED : undefined;
}

/** Runs work while holding the attempts lock; injectable so tests can simulate a takeover. */
export type Lock = <T>(path: string, signal: AbortSignal, work: () => Promise<T>) => Promise<T>;

const fileLock: Lock = (path, signal, work) => withFileLock(path, { signal }, work);

/** Full-content identity, so any change by another holder is detected. */
function identity(attempts: Attempt[] | 'invalid'): string {
  return attempts === 'invalid' ? attempts : JSON.stringify(attempts);
}

export type Claim<T> = {
  tool: MoneyTool;
  expectedCheckoutToken: string;
  signal: AbortSignal;
  /** Reads and verifies the live checkout; throws a fixed refusal before anything is recorded. */
  gate: () => Promise<{ token: string; total: number; print: string }>;
  /** Sends the one charge-bearing request; any failure is an unknown outcome. */
  send: () => Promise<T>;
  orderToken: (value: T) => string;
  lock?: Lock | undefined;
};

/**
 * Holds the attempts lock across the record check, gate, `submitting` write, request, and final
 * state, so concurrent or repeated calls for one approval send at most one request. Returns null
 * when the outcome is unknown, including every local failure after the request may have left.
 *
 * The lock does not fence a holder that lost it, so the record is also compared and swapped: the
 * snapshot must be unchanged after the gate, the `submitting` entry must be present after its
 * write, and the final write updates only this attempt's entry in freshly read content.
 */
export async function claimAttempt<T>(path: string, claim: Claim<T>): Promise<T | null> {
  // Set inside the locked callback immediately before sending; once true, the request may have left.
  const progress = { sending: false };
  const lock = claim.lock ?? fileLock;

  try {
    return await lock(path, claim.signal, async () => {
      await sweepTemp(path);
      const snapshot = await readAttempts(path);
      const early = blocker(snapshot, claim.tool, claim.expectedCheckoutToken);

      if (early) throw early;
      const checkout = await claim.gate();

      // Another holder may have written while the gate waited on Krónan; nothing is sent then.
      const fresh = await readAttempts(path);

      if (identity(fresh) !== identity(snapshot)) throw ATTEMPT_RACED;
      const late = blocker(fresh, claim.tool, checkout.token, checkout.print);

      if (late) throw late;
      const now = new Date().toISOString();

      const attempt: Attempt = {
        id: randomUUID(),
        tool: claim.tool,
        checkoutToken: checkout.token,
        fingerprint: checkout.print,
        total: checkout.total,
        state: 'submitting',
        orderToken: null,
        createdAt: now,
        updatedAt: now,
      };

      // Commit intent before the network call; a crash or timeout must never allow a second charge.
      await writeAttempts(path, [...fresh, attempt]);

      const committed = (await readAttempts(path)).some(
        (entry) => entry.id === attempt.id && entry.state === 'submitting',
      );

      if (!committed) throw ATTEMPT_RACED;
      progress.sending = true;
      let value: T | null = null;

      try {
        value = await claim.send();
      } catch {
        value = null;
      }

      const final: Attempt = {
        ...attempt,
        state: value === null ? 'unknown' : 'accepted',
        orderToken: value === null ? null : claim.orderToken(value),
        updatedAt: new Date().toISOString(),
      };

      // Every other entry is kept as it is now, including entries another holder added meanwhile.
      const current = await readAttempts(path);

      await writeAttempts(
        path,
        current.some((entry) => entry.id === attempt.id)
          ? current.map((entry) => (entry.id === attempt.id ? final : entry))
          : [...current, final],
      );

      return value;
    });
  } catch (error) {
    if (progress.sending) return null;

    if (error instanceof SafeError) throw error;
    throw ATTEMPTS_BUSY;
  }
}

/** For the CLI: the current records, or 'invalid' when the file cannot be parsed or trusted. */
export async function listAttempts(path: string): Promise<Attempt[] | 'invalid'> {
  try {
    return await readAttempts(path);
  } catch {
    return 'invalid';
  }
}

/**
 * For the CLI, after the human confirmed: removes the record only if its full content still equals
 * what was shown. Returns false when it changed meanwhile.
 */
export function clearAttempts(path: string, shown: Attempt[] | 'invalid'): Promise<boolean> {
  return withFileLock(path, {}, async () => {
    if (identity(await listAttempts(path)) !== identity(shown)) return false;
    await rm(path, { force: true });
    await sweepTemp(path);

    return true;
  });
}
