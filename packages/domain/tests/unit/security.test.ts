import { describe, expect, it } from 'vitest';
import { ipInCidr, isPrivateAddress, isSafeRelativePath, joinInsideRoot, redactSecrets, renderFilenameTemplate, sanitizeFilename, sniffAudioMime, truncateIp, validateOutboundUrl } from '../../src/security.js';

describe('security helpers', () => {
  it('blocks private, loopback, link-local, metadata and obfuscated addresses', () => {
    for (const h of ['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.0.1', '169.254.169.254', '100.64.1.1', '::1', 'fe80::1', 'fd00::1', 'localhost', 'metadata.google.internal', '2130706433', '0x7f000001', '::ffff:10.0.0.1', '224.0.0.1']) {
      expect(isPrivateAddress(h), h).toBe(true);
    }
    for (const h of ['8.8.8.8', 'example.com', '2606:4700::1111']) expect(isPrivateAddress(h), h).toBe(false);
  });
  it('validates outbound URLs with allowlists', () => {
    expect(validateOutboundUrl('https://www.youtube.com/watch?v=x', { allowedHosts: ['*.youtube.com', 'youtu.be'] }).ok).toBe(true);
    expect(validateOutboundUrl('https://evil.youtube.com.attacker.net/', { allowedHosts: ['*.youtube.com'] }).ok).toBe(false);
    expect(validateOutboundUrl('http://www.youtube.com/', { allowedHosts: ['*.youtube.com'] }).ok).toBe(false);
    expect(validateOutboundUrl('https://user:pw@www.youtube.com/', { allowedHosts: ['*.youtube.com'] }).ok).toBe(false);
    expect(validateOutboundUrl('https://169.254.169.254/latest', { allowedHosts: [] }).ok).toBe(false);
    expect(validateOutboundUrl('file:///etc/passwd', { allowedHosts: [] }).ok).toBe(false);
  });
  it('sanitizes filenames', () => {
    expect(sanitizeFilename('../..\\etc/passwd')).toBe('etc passwd');
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('   ')).toBe('untitled');
    expect(sanitizeFilename('a'.repeat(300) + '.mp3').length).toBeLessThanOrEqual(180);
    expect(renderFilenameTemplate('{artist} - {title}', { artist: 'A/B', title: 'T:x' }, '.FLAC')).toBe('A B - T x.flac');
  });
  it('rejects path traversal and absolute paths', () => {
    expect(isSafeRelativePath('music/a.mp3')).toBe(true);
    expect(isSafeRelativePath('../a.mp3')).toBe(false);
    expect(isSafeRelativePath('a/../../b')).toBe(false);
    expect(isSafeRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeRelativePath('C:\\x')).toBe(false);
    expect(isSafeRelativePath('a\0b')).toBe(false);
    expect(joinInsideRoot('/data/music', 'x/../y.mp3')).toBe('/data/music/y.mp3');
    expect(joinInsideRoot('/data/music', '../y.mp3')).toBeNull();
  });
  it('redacts secrets by key and by value shape', () => {
    const r = redactSecrets({ token: 'abc', nested: { Authorization: 'Bearer xyz', ok: 'fine' }, text: 'Bearer abcdefghijklmnop' });
    expect(r).toEqual({ token: '[REDACTED]', nested: { Authorization: '[REDACTED]', ok: 'fine' }, text: '[REDACTED]' });
  });
  it('truncates IPs and checks CIDRs', () => {
    expect(truncateIp('203.0.113.42')).toBe('203.0.113.x');
    expect(truncateIp('2001:db8:1234:5678::1')).toBe('2001:db8:1234::/48');
    expect(ipInCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipInCidr('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(ipInCidr('::ffff:10.1.1.1', '10.0.0.0/8')).toBe(true);
  });
  it('sniffs audio containers', () => {
    expect(sniffAudioMime(new TextEncoder().encode('fLaC....'))).toBe('audio/flac');
    expect(sniffAudioMime(new TextEncoder().encode('RIFF....WAVEfmt '))).toBe('audio/wav');
    expect(sniffAudioMime(new TextEncoder().encode('ID3'))).toBe('audio/mpeg');
    expect(sniffAudioMime(new Uint8Array([0x00, 0x00]))).toBeNull();
  });
});
