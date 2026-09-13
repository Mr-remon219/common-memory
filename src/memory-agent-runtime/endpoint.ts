export function requireInteger(name: string, value: number, min: number, max: number): void { if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer between ${min} and ${max}`); }
export function normalizeOpenAICompatibleBaseUrl(value: string): string {
  let url: URL; try { url = new URL(value); } catch { throw new TypeError('baseUrl must be an absolute HTTP(S) URL'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('baseUrl must use HTTP or HTTPS');
  if (url.username || url.password || url.search || url.hash) throw new TypeError('baseUrl must not contain credentials, query, or fragment');
  url.pathname = url.pathname.replace(/\/+$/u, '');
  if (/\/(responses|chat\/completions)$/u.test(url.pathname)) throw new TypeError('baseUrl must be the API root, not a completion endpoint');
  return url.toString().replace(/\/$/u, '');
}

