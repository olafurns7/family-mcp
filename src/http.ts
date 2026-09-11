import { Parser } from 'htmlparser2';
import { CookieJar } from 'tough-cookie';
import { z } from 'zod';
import {
  InfoMentorError,
  LOGIN_REQUIRED,
  PARENT_URL,
  pupilSchema,
  throwIfAborted,
  timetableEntrySchema,
  trustedUrl,
} from './session.js';

export type HttpPage = { url: string; text: string };

export type Form = { id: string; action: string; method: string; fields: URLSearchParams };

export function parseForms(html: string): Form[] {
  const forms: Form[] = [];
  let current: Form | undefined;

  const parser = new Parser({
    onopentag(name, attrs) {
      if (name === 'form') {
        current = {
          id: attrs['id'] ?? '',
          action: attrs['action'] ?? '',
          method: (attrs['method'] ?? 'get').toLowerCase(),
          fields: new URLSearchParams(),
        };
        forms.push(current);
      } else if (
        name === 'input' &&
        current &&
        attrs['name'] &&
        attrs['type']?.toLowerCase() === 'hidden' &&
        attrs['disabled'] === undefined
      ) {
        current.fields.append(attrs['name'], attrs['value'] ?? '');
      }
    },
    onclosetag(name) {
      if (name === 'form') current = undefined;
    },
  });

  parser.end(html);

  return forms;
}

/** Manual redirects keep cookie handling and destination validation on every hop. */
export class InfoMentorHttp {
  private cooldownUntil = 0;
  constructor(readonly jar = new CookieJar()) {}

  async request(
    value: string,
    fields?: URLSearchParams,
    signal?: AbortSignal,
    source = PARENT_URL,
  ): Promise<HttpPage> {
    if (Date.now() < this.cooldownUntil)
      throw new InfoMentorError(
        'RATE_LIMITED',
        'InfoMentor requested a pause. Wait before retrying.',
        this.cooldownUntil - Date.now(),
      );
    const deadline = AbortSignal.timeout(30_000);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let url = trustedUrl(value);
    let body = fields?.toString();
    let previous = trustedUrl(source);

    try {
      for (let hop = 0; hop < 10; hop++) {
        throwIfAborted(requestSignal);

        const headers = new Headers({
          Accept: 'application/json, text/html;q=0.9',
          Referer: previous.href,
        });

        const cookies = this.jar.getCookieStringSync(url.href);

        if (cookies) headers.set('Cookie', cookies);

        if (body !== undefined) {
          headers.set('Content-Type', 'application/x-www-form-urlencoded');
          headers.set('Origin', previous.origin);
        }

        const response = await fetch(url, {
          method: body === undefined ? 'GET' : 'POST',
          body: body ?? null,
          headers,
          redirect: 'manual',
          signal: requestSignal,
        });

        for (const cookie of response.headers.getSetCookie())
          this.jar.setCookieSync(cookie, url.href, { ignoreError: true });

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');

          if (!location)
            throw new InfoMentorError(
              'UNEXPECTED_PAGE',
              'InfoMentor returned a redirect without a destination.',
            );
          const next = trustedUrl(new URL(location, url).href);

          if ([301, 302, 303].includes(response.status)) body = undefined;

          // Credentials are posted only to the login form's origin, never forwarded by a 307/308.
          if (body !== undefined && next.origin !== url.origin)
            throw new InfoMentorError(
              'UNEXPECTED_PAGE',
              'InfoMentor requested an unsupported cross-origin form redirect.',
            );
          previous = url;
          url = next;
          continue;
        }

        if (response.status === 429) {
          await response.body?.cancel();
          const retry = response.headers.get('retry-after');

          const milliseconds =
            retry && /^\d+$/.test(retry)
              ? Number(retry) * 1000
              : retry
                ? Date.parse(retry) - Date.now()
                : NaN;

          const wait = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 60_000;
          this.cooldownUntil = Date.now() + wait;
          throw new InfoMentorError(
            'RATE_LIMITED',
            'InfoMentor is limiting requests. No automatic retry was made.',
            wait,
          );
        }

        const text = await readBody(response, requestSignal);

        if (
          /challenge-running|challenge-stage|challenges\.cloudflare\.com|<title[^>]*>\s*(?:just a moment|security check|verify you are human)/i.test(
            text,
          )
        )
          throw new InfoMentorError(
            'CHALLENGE_REQUIRED',
            'InfoMentor requires an interactive security check. Direct HTTP login cannot complete it; no automatic retry was made.',
          );

        if (response.status === 401) throw new InfoMentorError('LOGIN_REQUIRED', LOGIN_REQUIRED);

        if (response.status === 403)
          throw new InfoMentorError(
            'ACCESS_DENIED',
            'InfoMentor denied access. Check the account before retrying.',
          );

        if (!response.ok)
          throw new InfoMentorError(
            'NETWORK_ERROR',
            'InfoMentor returned an error. Try again later.',
          );

        return { url: url.href, text };
      }

      throw new InfoMentorError('UNEXPECTED_PAGE', 'InfoMentor returned too many redirects.');
    } catch (error) {
      throwIfAborted(signal);

      if (error instanceof InfoMentorError) throw error;
      throw new InfoMentorError(
        'NETWORK_ERROR',
        deadline.aborted
          ? 'InfoMentor request timed out.'
          : 'InfoMentor request failed. Check the network.',
      );
    }
  }

  async isAuthenticated(signal?: AbortSignal): Promise<boolean> {
    const page = await this.request(
      new URL('authentication/authentication/isauthenticated/', PARENT_URL).href,
      new URLSearchParams(),
      signal,
    );

    if (/^\s*(?:true|false)\s*$/.test(page.text)) return page.text.trim() === 'true';

    if (/\/authentication\/authentication\/login(?:callback)?\b/i.test(new URL(page.url).pathname))
      return false;
    throw new InfoMentorError(
      'UNEXPECTED_PAGE',
      'InfoMentor returned an unsupported authentication response.',
    );
  }

  async requireAuthentication(signal?: AbortSignal): Promise<void> {
    if (!(await this.isAuthenticated(signal)))
      throw new InfoMentorError('LOGIN_REQUIRED', LOGIN_REQUIRED);
  }
}

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();

  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();

      if (done) break;
      size += value.byteLength;

      if (size > 8 * 1024 * 1024)
        throw new InfoMentorError(
          'UNEXPECTED_PAGE',
          'InfoMentor returned an unexpectedly large response.',
        );
      chunks.push(value);
    }

    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export const parentSchema = z.object({
  account: z.object({ pupils: z.array(pupilSchema) }),
  apps: z.array(z.object({ codeName: z.string() })),
});

export const timetableSchema = z.object({ items: z.array(timetableEntrySchema) });

/** Read the JSON assignment; never evaluate scripts returned by the school site. */
export function parseParent(html: string): z.infer<typeof parentSchema> {
  let model: z.infer<typeof parentSchema> | undefined;
  let inScript = false;
  let script = '';

  const parser = new Parser({
    onopentag(name) {
      if (name === 'script') {
        inScript = true;
        script = '';
      }
    },
    ontext(text) {
      if (inScript) script += text;
    },
    onclosetag(name) {
      if (name !== 'script') return;
      inScript = false;
      const match = /IMHome\.home\.homeData\s*=\s*([\s\S]*?);\s*IMHome\.home\.init\(/.exec(script);

      if (!match?.[1]) return;

      try {
        model = parentSchema.parse(JSON.parse(match[1]));
      } catch {
        /* Reject incompatible bootstrap below. */
      }
    },
  });

  parser.end(html);

  if (!model)
    throw new InfoMentorError(
      'UNEXPECTED_PAGE',
      'InfoMentor parent data has changed or is unavailable.',
    );

  return model;
}
