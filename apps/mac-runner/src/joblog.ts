/**
 * One job's log, in the console's format (GitHub Actions' own): an ISO time on every line,
 * `##[group]Run …` opening each step, `##[error]` for what failed. Lines collect here and go to
 * the console with the next report, which appends them to the job's log there.
 */
export class LogBuffer {
  private parts: string[] = [];
  private bytes = 0;
  private partial = '';

  line(text: string): void {
    const s = `${new Date().toISOString()} ${text}\n`;
    this.parts.push(s);
    this.bytes += s.length;
  }

  /** Opens a step: the console splits the log into steps at these lines. */
  step(command: string): void {
    const lines = command.split('\n');
    this.line(`##[group]Run ${lines[0]}`);
    for (const extra of lines.slice(1)) this.line(extra);
    this.line('##[endgroup]');
  }

  error(message: string): void {
    this.line(`##[error]${message}`);
  }

  warning(message: string): void {
    this.line(`##[warning]${message}`);
  }

  /** Raw process output, split into lines (xcodebuild and pod redraw progress with \r). */
  chunk(data: Buffer | string): void {
    const text = this.partial + data.toString();
    const pieces = text.split(/\r\n|\n|\r/);
    this.partial = pieces.pop() ?? '';
    for (const p of pieces) if (p.length) this.line(p);
    // A line that never ends (a progress bar) still reaches the console.
    if (this.partial.length > 16 * 1024) this.flush();
  }

  flush(): void {
    if (this.partial) {
      this.line(this.partial);
      this.partial = '';
    }
  }

  get size(): number {
    return this.bytes;
  }

  /** Takes up to `max` bytes of whole lines for a report. */
  drain(max: number): string {
    let out = '';
    while (this.parts.length && (out.length === 0 || out.length + this.parts[0].length <= max)) {
      const p = this.parts.shift()!;
      this.bytes -= p.length;
      out += p;
    }
    return out;
  }

  /** Puts text back at the front after a report that did not reach the console. */
  unshift(text: string): void {
    if (!text) return;
    this.parts.unshift(text);
    this.bytes += text.length;
  }
}
