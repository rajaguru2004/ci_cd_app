import { readFileSync } from 'fs';
import { join } from 'path';

/** The console and the Mac runner's agent speak from one description of their protocol and one sealing scheme. */
describe('what the console and the Mac runner share', () => {
  const agent = join(__dirname, '..', '..', 'mac-runner', 'src');

  it('has the same protocol file on both sides', () => {
    expect(readFileSync(join(agent, 'protocol.ts'), 'utf8')).toBe(readFileSync(join(__dirname, 'mac-protocol.ts'), 'utf8'));
  });

  it('seals and opens secrets with the same code on both sides', () => {
    const body = (f: string) => readFileSync(f, 'utf8').replace(/The same file is in apps\/\S+\./, '');
    expect(body(join(agent, 'seal.ts'))).toBe(body(join(__dirname, 'seal.ts')));
  });
});
