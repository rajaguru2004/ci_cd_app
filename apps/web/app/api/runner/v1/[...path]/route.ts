/**
 * The Mac runners' gateway, streamed straight to the console API: a long poll waits there,
 * a source download and an IPA upload pass through without being held in memory (the /api/*
 * rewrite in next.config.ts would buffer a body and cut it at 10 MB). The API and the builder
 * check each runner's token; this route only carries the bytes.
 */
const apiUrl = (process.env.API_INTERNAL_URL || 'http://localhost:3001').replace(/\/+$/, '');

export const dynamic = 'force-dynamic';

async function pass(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const url = new URL(req.url);
  const headers = new Headers();
  for (const name of ['authorization', 'content-type', 'content-length', 'user-agent']) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) headers.set('x-forwarded-for', forwarded);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/runner/v1/${path.map(encodeURIComponent).join('/')}${url.search}`, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      // Streams the request body instead of reading it all first.
      ...(hasBody ? { duplex: 'half' } : {}),
      cache: 'no-store',
      signal: req.signal,
    } as RequestInit & { duplex?: 'half' });
  } catch {
    return Response.json({ statusCode: 502, message: 'The console API is not answering; the runner tries again.' }, { status: 502 });
  }
  const out = new Headers();
  for (const name of ['content-type', 'content-length']) {
    const value = res.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(res.body, { status: res.status, headers: out });
}

export const GET = pass;
export const POST = pass;
export const PUT = pass;
