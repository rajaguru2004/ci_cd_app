import { createWriteStream, WriteStream } from 'fs';

/**
 * One job's log, written in the format GitHub Actions uses, so the console's log view reads
 * it unchanged: an ISO timestamp on every line, `##[group]Run …` opening each step,
 * `##[error]` for what failed. The file is append-only and read while it grows, which is how
 * the console shows a local job's log live.
 */
export class JobLog {
  private readonly out: WriteStream;
  private partial = '';

  constructor(readonly file: string) {
    this.out = createWriteStream(file, { flags: 'a' });
  }

  line(text: string): void {
    this.out.write(`${new Date().toISOString()} ${text}\n`);
  }

  /** Opens a step: the console splits the log into steps at these lines. */
  step(command: string): void {
    this.line(`##[group]Run ${command.split('\n')[0]}`);
    for (const extra of command.split('\n').slice(1)) this.line(extra);
    this.line('##[endgroup]');
  }

  error(message: string): void {
    this.line(`##[error]${message}`);
  }

  warning(message: string): void {
    this.line(`##[warning]${message}`);
  }

  /** Raw process output: split into lines (Gradle and pub redraw progress with \r). */
  chunk(data: Buffer | string): void {
    const text = this.partial + data.toString('utf8');
    const parts = text.split(/\r\n|\n|\r/);
    this.partial = parts.pop() ?? '';
    for (const p of parts) if (p.length) this.line(p);
  }

  flush(): void {
    if (this.partial) {
      this.line(this.partial);
      this.partial = '';
    }
  }

  close(): Promise<void> {
    this.flush();
    return new Promise((done) => this.out.end(done));
  }
}
