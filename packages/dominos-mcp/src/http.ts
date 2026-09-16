import { readBody, SafeError } from '@family-mcp/mcp-runtime';
import type * as z from 'zod/v4';

export const API = 'https://api.dominos.is/api/';

export const WEBSITE = 'https://www.dominos.is';

export const ADYEN = 'https://checkoutshopper-live.adyen.com';

export type Request = (url: string, options: RequestInit) => Promise<Response>;

export class HttpError extends SafeError {
  constructor(readonly status: number) {
    super('Domino’s or its payment provider rejected the request. No automatic retry was made.');
  }
}

/** A bounded exchange; neither error bodies nor credential-bearing URLs escape this boundary. */
export async function requestText(
  request: Request,
  url: string,
  options: RequestInit,
  lifecycle: AbortSignal,
): Promise<string> {
  const signal = AbortSignal.any([lifecycle, AbortSignal.timeout(25_000)]);

  try {
    const response = await request(url, { ...options, redirect: 'error', signal });

    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status);
    }

    return await readBody(response, 8 * 1024 * 1024, signal);
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError(
      'The request failed or timed out. Its result may be unknown; do not repeat a payment.',
    );
  }
}

export async function requestJson<T>(
  request: Request,
  url: string,
  options: RequestInit,
  lifecycle: AbortSignal,
  schema: z.ZodType<T>,
): Promise<T> {
  const text = await requestText(request, url, options, lifecycle);

  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw new SafeError(
      'Unexpected response from Domino’s or its payment provider. The service may have changed.',
    );
  }
}
