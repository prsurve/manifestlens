/** Hosts the page may fetch a CRD from. The page's Content-Security-Policy allows the same list. */
export const CRD_HOSTS = ['raw.githubusercontent.com', 'gist.githubusercontent.com'];

const MAX_BYTES = 8 * 1024 * 1024;

/**
 * The raw-file URL for what the user typed, or undefined if it is not one we fetch. A normal GitHub
 * file link (`github.com/o/r/blob/main/crd.yaml`) is turned into its raw form.
 */
export function toRawUrl(input: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
  if (url.hostname === 'github.com') {
    const m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
    if (!m) return undefined;
    return new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`);
  }
  return CRD_HOSTS.includes(url.hostname) ? url : undefined;
}

/** Download the text at a URL accepted by {@link toRawUrl}; throws an Error with a message to show. */
export async function fetchCrdText(url: URL): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!res.ok) throw new Error(`The server answered ${res.status} for that URL.`);
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_BYTES) throw new Error('That file is too large.');
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('That file is too large.');
    return text;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Timed out fetching that URL.', { cause: err });
    }
    if (err instanceof TypeError) {
      throw new Error('Could not fetch that URL. Check it, or paste the YAML instead.', {
        cause: err,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
