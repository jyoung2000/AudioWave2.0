/**
 * The 2010 page chrome: the status bar's controls, the section strip and the hero's transport.
 *
 * These are behaviour tests, not snapshots. The section strip in particular replaced a sidebar, and
 * the point of the replacement was that it keeps the *same* keyboard model — one tab stop, arrows
 * to move, Enter to choose, type-ahead. If that stops being true the redesign broke something a
 * person relied on, and this is where it shows.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModeSwitch, type ListeningMode } from '../../src/components/PageBar.js';
import { SectionStrip } from '../../src/components/SectionStrip.js';
import { KeyButton, KeyTransport, LevelSlider, TrackScrubber } from '../../src/components/Hero.js';
import './setup.js';

const sections = [
  { id: 'library', label: 'Music' },
  { id: 'now', label: 'Now playing' },
  { id: 'queue', label: 'Up next' },
  { id: 'settings', label: 'Settings' },
];

describe('SectionStrip', () => {
  it('has one tab stop, moves with arrows and Home/End, chooses with Enter, and answers type-ahead', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<SectionStrip items={sections} selectedId="library" onSelect={onSelect} />);

    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeTruthy();
    const options = screen.getAllByRole('option');
    expect(options.filter((option) => option.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(screen.getByRole('option', { name: 'Music' }).getAttribute('aria-selected')).toBe('true');

    screen.getByRole('option', { name: 'Music' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Now playing' }));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Settings' }));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Music' }));
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('library');
    await user.keyboard('u');
    expect(document.activeElement).toBe(screen.getByRole('option', { name: /Up next/ }));
  });

  it('shows a count only when there is something to count', () => {
    render(<SectionStrip items={[{ id: 'queue', label: 'Up next', count: 0 }, { id: 'pl', label: 'Playlists', count: 3 }]} selectedId="queue" onSelect={() => undefined} />);
    expect(screen.queryByLabelText('0 items')).toBeNull();
    expect(screen.getByLabelText('3 items').textContent).toBe('3');
  });
});

describe('ModeSwitch', () => {
  const modes: [ListeningMode, ListeningMode] = [
    { id: 'solo', label: 'Solo listening' },
    { id: 'shared', label: 'Shared listening' },
  ];

  it('is a radio group where only the chosen mode is checked', () => {
    render(<ModeSwitch modes={modes} value="solo" onChange={() => undefined} />);
    expect(screen.getByRole('radiogroup', { name: 'Listening mode' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Solo listening' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Shared listening' }).getAttribute('aria-checked')).toBe('false');
  });

  it('switches with the arrow keys as well as the pointer', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ModeSwitch modes={modes} value="solo" onChange={onChange} />);
    screen.getByRole('radio', { name: 'Solo listening' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('shared');
  });

  /**
   * The rule the whole capability model rests on: a mode that cannot work stays visible and says
   * why when pressed. It never silently does nothing, and it never disappears.
   */
  it('reports the reason instead of switching when a mode is unavailable', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onBlocked = vi.fn();
    const blocked: [ListeningMode, ListeningMode] = [modes[0], { ...modes[1], unavailableReason: 'Shared listening needs a paired hub.' }];
    render(<ModeSwitch modes={blocked} value="solo" onChange={onChange} onBlocked={onBlocked} />);

    const shared = screen.getByRole('radio', { name: /Shared listening — Shared listening needs a paired hub\./ });
    expect(shared.getAttribute('aria-disabled')).toBe('true');
    await user.click(shared);
    expect(onChange).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledWith('Shared listening needs a paired hub.');
  });
});

describe('TrackScrubber', () => {
  it('reports its position, seeks with the arrow keys, and jumps with Home and End', async () => {
    const user = userEvent.setup();
    const onSeek = vi.fn();
    render(<TrackScrubber positionMs={30_000} durationMs={180_000} onSeek={onSeek} />);
    const rail = screen.getByRole('slider', { name: 'Playback position' });
    expect(rail.getAttribute('aria-valuenow')).toBe('30');
    expect(rail.getAttribute('aria-valuemax')).toBe('180');
    expect(rail.getAttribute('aria-valuetext')).toBe('00:30 of 03:00');

    rail.focus();
    await user.keyboard('{ArrowRight}');
    expect(onSeek).toHaveBeenLastCalledWith(35_000);
    await user.keyboard('{End}');
    expect(onSeek).toHaveBeenLastCalledWith(180_000);
  });

  it('goes read-only for a live broadcast and says why', () => {
    render(<TrackScrubber positionMs={10_000} durationMs={180_000} onSeek={() => undefined} live disabledReason="A shared broadcast has one position." />);
    const rail = screen.getByRole('slider', { name: 'Playback position' });
    expect(rail.getAttribute('aria-disabled')).toBe('true');
    expect(rail.getAttribute('title')).toBe('A shared broadcast has one position.');
    // The remaining-time stamp is replaced by the LIVE marker rather than counting down to nothing.
    expect(screen.getByText('LIVE')).toBeTruthy();
  });

  it('admits when it does not know how long the track is', () => {
    render(<TrackScrubber positionMs={4000} durationMs={null} onSeek={() => undefined} />);
    const rail = screen.getByRole('slider', { name: 'Playback position' });
    expect(rail.getAttribute('aria-valuetext')).toBe('00:04, length unknown');
    expect(screen.getByText('--:--')).toBeTruthy();
  });
});

describe('the hero transport', () => {
  it('groups the keys under one name and keeps the aux controls inside it', () => {
    render(
      <KeyTransport volume={<LevelSlider value={0.5} onChange={() => undefined} />}>
        <KeyButton aux label="Add to favourites" onClick={() => undefined} glyph="play" />
        <KeyButton glyph="previous" label="Previous track" onClick={() => undefined} />
        <KeyButton primary glyph="play" label="Play" onClick={() => undefined} />
        <KeyButton glyph="next" label="Next track" onClick={() => undefined} />
      </KeyTransport>,
    );
    const group = screen.getByRole('group', { name: 'Playback controls' });
    for (const name of ['Add to favourites', 'Previous track', 'Play', 'Next track']) {
      expect(group.querySelector(`[aria-label="${name}"]`), name).toBeTruthy();
    }
    expect(screen.getByRole('slider', { name: 'Volume' }).getAttribute('aria-valuenow')).toBe('50');
  });

  it('reads muted as muted rather than as zero', () => {
    render(<LevelSlider value={0.8} muted onChange={() => undefined} onToggleMute={() => undefined} />);
    const slider = screen.getByRole('slider', { name: 'Volume' });
    expect(slider.getAttribute('aria-valuetext')).toBe('Muted');
    expect(screen.getByRole('button', { name: 'Unmute' }).getAttribute('aria-pressed')).toBe('true');
  });
});
