import { fingerprint, generateKeys, open, parsePublicKey, seal } from './seal';

describe('secrets sealed for a Mac runner', () => {
  const mac = generateKeys();

  it('opens with the runner’s key and the same purpose, and only so', () => {
    const sealed = seal(Buffer.from('{"certificate.password":"cGFzcw=="}'), mac.publicKey, 'run:12');
    expect(open(sealed, mac.privatePem, 'run:12').toString()).toBe('{"certificate.password":"cGFzcw=="}');
    // Replayed for another run, or read with another key: refused.
    expect(() => open(sealed, mac.privatePem, 'run:13')).toThrow('do not open');
    expect(() => open(sealed, generateKeys().privatePem, 'run:12')).toThrow('do not open');
  });

  it('is fresh every time and detects tampering', () => {
    const a = seal(Buffer.from('same'), mac.publicKey, 'run:1');
    const b = seal(Buffer.from('same'), mac.publicKey, 'run:1');
    expect(a).not.toBe(b);
    const bytes = Buffer.from(a, 'base64');
    bytes[bytes.length - 1] ^= 1;
    expect(() => open(bytes.toString('base64'), mac.privatePem, 'run:1')).toThrow('do not open');
    expect(() => open('AAAA', mac.privatePem, 'run:1')).toThrow('Not a sealed message');
  });

  it('takes only a base64 X25519 public key, and prints its fingerprint like ssh-keygen', () => {
    expect(parsePublicKey(mac.publicKey)).toHaveLength(32);
    expect(() => parsePublicKey('not a key')).toThrow('X25519');
    expect(() => parsePublicKey(undefined)).toThrow('X25519');
    expect(fingerprint(parsePublicKey(mac.publicKey))).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});
