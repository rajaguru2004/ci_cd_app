/**
 * The only way the UI talks to the console API (same origin, /api/*). A refusal becomes an
 * ApiError carrying the server's own sentence: the screens show it verbatim rather than
 * guessing a friendlier one (the server knows what went wrong; the screen does not).
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function messageFrom(body: unknown, status: number): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message: unknown }).message;
    if (Array.isArray(m)) return m.join(' ');
    if (typeof m === 'string' && m) return m;
  }
  if (status === 502 || status === 504) return 'The console API is not answering. Is the api container running?';
  return `Request failed (${status}).`;
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...rest,
      headers: {
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(rest.headers ?? {}),
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError('The console could not be reached. Check the connection and try again.', 0);
  }
  if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/')) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.assign(`/login?next=${next}`);
    throw new ApiError('Signed out.', 401);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new ApiError(messageFrom(body, res.status), res.status);
  return body as T;
}

/**
 * Sends a multipart form (a source ZIP and its fields) and reports upload progress, which
 * fetch cannot. Errors read exactly like api()'s.
 */
export function uploadForm<T>(path: string, form: FormData, onProgress: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError('The upload was interrupted. Check the connection and try again.', 0));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = xhr.responseText;
      }
      if (xhr.status === 401 && typeof window !== 'undefined') {
        window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
        return reject(new ApiError('Signed out.', 401));
      }
      if (xhr.status === 413) return reject(new ApiError('That ZIP is larger than the console accepts (MAX_UPLOAD_MB).', 413));
      if (xhr.status < 200 || xhr.status >= 300) return reject(new ApiError(messageFrom(body, xhr.status), xhr.status));
      resolve(body as T);
    };
    xhr.send(form);
  });
}
