/**
 * Source ZIP uploads stream straight through to the console API. The /api/* rewrite in
 * next.config.ts would buffer the body and cut it at 10 MB; a GitHub source ZIP is larger.
 * The API still checks the session cookie, the size (MAX_UPLOAD_MB) and that it is a ZIP.
 */
const apiUrl = (process.env.API_INTERNAL_URL || 'http://localhost:3001').replace(/\/+$/, '');

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const headers = new Headers();
  for (const name of ['content-type', 'cookie', 'user-agent']) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/runs/upload`, {
      method: 'POST',
      headers,
      body: req.body,
      // Streams the request body instead of reading it all first.
      duplex: 'half',
      cache: 'no-store',
    } as RequestInit & { duplex: 'half' });
  } catch {
    return Response.json(
      { statusCode: 502, message: 'The console API is not answering. Is the api container running?' },
      { status: 502 },
    );
  }
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}
