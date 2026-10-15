import { request as httpRequest, type IncomingMessage } from 'http';
import { request as httpsRequest } from 'https';
import type { Readable } from 'stream';
import type { CompleteRequest, ConnectReply, ConnectRequest, EventsReply, EventsRequest, PollReply } from './protocol';

/**
 * The agent's side of the conversation with the console: plain HTTP(S) to the console's own
 * address, the runner token on every request. Only the agent ever dials; the console never
 * reaches into the Mac.
 */

export class ConsoleError extends Error {
  constructor(
    message: string,
    /** The console's status, or 0 when it was not reached. */
    readonly status: number,
  ) {
    super(message);
    this.name = 'ConsoleError';
  }
}

export class ConsoleApi {
  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
  ) {}

  connect(body: ConnectRequest): Promise<ConnectReply> {
    return this.json('POST', '/runner/v1/connect', body, 30_000);
  }

  poll(activeRun: number | null, waitSeconds: number): Promise<PollReply> {
    return this.json('POST', '/runner/v1/poll', { activeRun }, (waitSeconds + 20) * 1000);
  }

  accept(runId: number): Promise<{ ok: true }> {
    return this.json('POST', `/runner/v1/runs/${runId}/accept`, {}, 30_000);
  }

  events(runId: number, body: EventsRequest): Promise<EventsReply> {
    return this.json('POST', `/runner/v1/runs/${runId}/events`, body, 60_000);
  }

  complete(runId: number, body: CompleteRequest): Promise<{ ok: true }> {
    return this.json('POST', `/runner/v1/runs/${runId}/complete`, body, 60_000);
  }

  /** The run's packed source as a stream (the caller pipes it onto the Mac). */
  async source(runId: number): Promise<{ size: number; stream: IncomingMessage }> {
    const res = await this.raw('GET', `/runner/v1/runs/${runId}/source`, null, 0, 120_000);
    if (res.statusCode !== 200) throw await this.refusal(res);
    return { size: Number(res.headers['content-length']) || 0, stream: res };
  }

  /** Streams one output file of a run to the console. */
  async artifact(runId: number, name: string, file: string, size: number, body: Readable): Promise<void> {
    const res = await this.raw('PUT', `/runner/v1/runs/${runId}/artifacts/${encodeURIComponent(name)}/${encodeURIComponent(file)}`, body, size, 60 * 60_000);
    if (res.statusCode !== 200) throw await this.refusal(res);
    res.resume();
  }

  private async json<T>(method: string, path: string, body: unknown, timeoutMs: number): Promise<T> {
    const data = Buffer.from(JSON.stringify(body));
    const res = await this.raw(method, path, data, data.length, timeoutMs, 'application/json');
    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
      const text = await readAll(res);
      return (text ? JSON.parse(text) : {}) as T;
    }
    throw await this.refusal(res);
  }

  private raw(method: string, path: string, body: Buffer | Readable | null, length: number, timeoutMs: number, type = 'application/octet-stream'): Promise<IncomingMessage> {
    const url = new URL(`${this.serverUrl}/api${path}`);
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = send(
        url,
        {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            'user-agent': 'release-console-mac-runner',
            ...(body ? { 'content-type': type, 'content-length': String(length) } : {}),
          },
          timeout: timeoutMs,
        },
        resolve,
      );
      req.on('timeout', () => req.destroy(new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`)));
      req.on('error', (e) => reject(new ConsoleError(`The console at ${this.serverUrl} did not answer (${e.message}).`, 0)));
      if (body === null) req.end();
      else if (Buffer.isBuffer(body)) req.end(body);
      else {
        body.on('error', (e) => req.destroy(e));
        body.pipe(req);
      }
    });
  }

  private async refusal(res: IncomingMessage): Promise<ConsoleError> {
    const text = await readAll(res).catch(() => '');
    let message = '';
    try {
      message = (JSON.parse(text) as { message?: string | string[] }).message?.toString() ?? '';
    } catch {
      message = text.slice(0, 300);
    }
    const status = res.statusCode ?? 0;
    if (status === 404 && !message) message = `${this.serverUrl} is not a Release Console (no runner gateway at /api/runner/v1): check SERVER_URL.`;
    return new ConsoleError(message || `The console answered ${status}.`, status);
  }
}

function readAll(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}
