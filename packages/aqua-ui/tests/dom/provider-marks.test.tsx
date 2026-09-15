/**
 * The marks have to survive two things: being told apart without colour, and being replaced by an
 * official asset. Both are properties of the drawing rather than of any one screen, so they are
 * asserted here and not in a screenshot.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PROVIDER_MARKS, ProviderMark, markFor, initialsFrom } from '../../src/icons/provider-marks.js';
import { ProviderArtworkProvider } from '../../src/lib/provider-artwork.js';
import { SourceBadge } from '../../src/components/Badge.js';
import { sourceOf } from '../../src/lib/track-source.js';
import './setup.js';

describe('platform marks', () => {
  it('draws a distinct glyph for every platform, so the set reads in greyscale', () => {
    const glyphs = Object.values(PROVIDER_MARKS).map((mark) => mark.glyph);
    expect(glyphs.every((glyph) => glyph !== null)).toBe(true);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it('gives every platform its own colour', () => {
    const tops = Object.values(PROVIDER_MARKS).map((mark) => mark.tile[0]);
    expect(new Set(tops).size).toBe(tops.length);
  });

  it('falls back to initials for a platform it has never heard of', () => {
    const unknown = markFor('some-new-service');
    expect(unknown.glyph).toBeNull();
    expect(unknown.initials).toBe('SN');
    expect(initialsFrom('bandcamp')).toBe('B');

    const { container } = render(<ProviderMark provider="some-new-service" title="Some New Service" />);
    expect(container.querySelector('text')?.textContent).toBe('SN');
  });

  it('is decorative unless it is given a name, and never a bare picture with no name', () => {
    const { container, rerender } = render(<ProviderMark provider="youtube" />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    rerender(<ProviderMark provider="youtube" title="YouTube" />);
    expect(screen.getByRole('img', { name: 'YouTube' })).toBeTruthy();
  });

  it('uses a supplied official asset in place of the mark, untouched', () => {
    const { container } = render(
      <ProviderArtworkProvider artwork={{ spotify: 'blob:official-spotify' }}>
        <ProviderMark provider="spotify" title="Spotify" />
      </ProviderArtworkProvider>,
    );
    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('blob:official-spotify');
    expect(image?.getAttribute('alt')).toBe('Spotify');
    // No tile, no recolour: the asset is the whole mark.
    expect(container.querySelector('svg')).toBeNull();
  });

  it('leaves platforms without supplied artwork on the built-in mark', () => {
    const { container } = render(
      <ProviderArtworkProvider artwork={{ spotify: 'blob:official-spotify' }}>
        <ProviderMark provider="youtube" title="YouTube" />
      </ProviderArtworkProvider>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).toBeTruthy();
  });
});

describe('SourceBadge', () => {
  it('names the platform whether or not it links out', () => {
    render(<SourceBadge provider="soundcloud" />);
    expect(screen.getByRole('img', { name: 'SoundCloud' })).toBeTruthy();
  });

  it('links to the track at its source when there is one, and says where it goes', () => {
    render(<SourceBadge provider="bandcamp" href="https://example.bandcamp.com/track/one" />);
    const link = screen.getByRole('link', { name: 'Open on Bandcamp' });
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});

describe('sourceOf', () => {
  it('hands the row a provider slug so it can draw that platform', () => {
    expect(sourceOf({ title: 'One', locators: [{ kind: 'provider', provider: 'soundcloud', providerTrackId: 'x', canonicalUrl: 'https://soundcloud.com/x' }] })).toMatchObject({
      provider: 'soundcloud',
      name: 'SoundCloud',
      href: 'https://soundcloud.com/x',
    });
    expect(sourceOf({ title: 'Two', locators: [{ kind: 'hub-blob', hubId: 'h', blobId: 'b' }] }).provider).toBe('hub');
    expect(sourceOf({ title: 'Three', locators: [] }).provider).toBe('local');
  });
});
