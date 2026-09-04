/**
 * The 2010 page chrome: the status bar's controls, the section strip and the hero's transport.
 *
 * These are behaviour tests, not snapshots. The section strip in particular replaced a sidebar, and
 * the point of the replacement was that it keeps the *same* keyboard model — one tab stop, arrows
 * to move, Enter to choose, type-ahead. If that stops being true the redesign broke something a
 * person relied on, and this is where it shows.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BarClock, BarSearch, ModeSwitch, type ListeningMode } from '../../src/components/PageBar.js';
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
   * A native segmented control's whole key model, not just the two arrows: both axes, Home/End, and
   * Space/Return re-committing the segment under the ring. The focus has to travel with the
   * selection too — the tab stop roves, so a ring left behind on an untabbable segment would let
   * the next Tab escape the group from a place the user cannot see.
   */
  it('answers both arrow axes, Home, End and Space, and takes the focus with it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ModeSwitch modes={modes} value="solo" onChange={onChange} />);
    const solo = screen.getByRole('radio', { name: 'Solo listening' });
    const shared = screen.getByRole('radio', { name: 'Shared listening' });

    solo.focus();
    await user.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith('shared');
    expect(document.activeElement).toBe(shared);

    await user.keyboard('{ArrowUp}');
    expect(onChange).toHaveBeenLastCalledWith('solo');
    expect(document.activeElement).toBe(solo);

    await user.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('shared');
    await user.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith('solo');

    onChange.mockClear();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith('solo');
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
    // Not a slider any more: a rail that cannot be moved should not offer a screen-reader user a
    // value to change and then refuse every attempt at changing it.
    expect(screen.queryByRole('slider')).toBeNull();
    const rail = screen.getByRole('img', { name: 'Live broadcast, 00:10 elapsed' });
    expect(rail.getAttribute('aria-disabled')).toBe('true');
    expect(rail.getAttribute('aria-valuenow')).toBeNull();
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

/**
 * The search field is a combobox: the focus never leaves it, and the list beneath is pointed at
 * with `aria-activedescendant`. Everything below is about that contract holding — a key that gets
 * swallowed, or a press that steals the focus, breaks the pointer and the popover with it.
 */
describe('BarSearch', () => {
  const rows = <div id="np-search-list" role="listbox" aria-label="Results" />;

  it('closes on Escape but keeps what was typed', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onChange = vi.fn();
    render(<BarSearch label="Search" value="mazzy" onChange={onChange} open onOpenChange={onOpenChange} results={rows} controls="np-search-list" />);
    screen.getByRole('combobox', { name: 'Search' }).focus();
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // Escape puts the list away. Emptying the field as well would cost a retype for nothing.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('brings a dismissed list back with the first arrow, and pages with PageDown', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onArrow = vi.fn();
    const onPage = vi.fn();
    const { rerender } = render(
      <BarSearch label="Search" value="mazzy" onChange={() => undefined} open={false} onOpenChange={onOpenChange} onArrow={onArrow} onPage={onPage} />,
    );
    screen.getByRole('combobox', { name: 'Search' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(onArrow).not.toHaveBeenCalled();

    rerender(<BarSearch label="Search" value="mazzy" onChange={() => undefined} open onOpenChange={onOpenChange} onArrow={onArrow} onPage={onPage} results={rows} controls="np-search-list" />);
    await user.keyboard('{ArrowDown}');
    expect(onArrow).toHaveBeenCalledWith(1);
    await user.keyboard('{PageDown}');
    expect(onPage).toHaveBeenCalledWith(1);
    await user.keyboard('{PageUp}');
    expect(onPage).toHaveBeenLastCalledWith(-1);
  });

  it('keeps the focus in the field when the popover is pressed', async () => {
    const user = userEvent.setup();
    render(
      <BarSearch
        label="Search"
        value="mazzy"
        onChange={() => undefined}
        open
        onOpenChange={() => undefined}
        controls="np-search-list"
        results={
          <div id="np-search-list" role="listbox" aria-label="Results">
            <button type="button">Fade Into You</button>
          </div>
        }
      />,
    );
    const field = screen.getByRole('combobox', { name: 'Search' });
    field.focus();
    await user.click(screen.getByRole('button', { name: 'Fade Into You' }));
    // A blur here would drop aria-activedescendant and close the list out from under the press.
    expect(document.activeElement).toBe(field);
  });
});

describe('BarClock', () => {
  it('changes on the minute boundary rather than on a fixed poll', () => {
    vi.useFakeTimers();
    // 20 seconds past the minute: a naive 20 s poll would next fire at :40, twenty seconds early.
    vi.setSystemTime(new Date(2026, 0, 1, 11, 35, 20));
    try {
      render(<BarClock />);
      expect(screen.getByText('11:35')).toBeTruthy();
      act(() => vi.advanceTimersByTime(39_000));
      expect(screen.getByText('11:35')).toBeTruthy();
      act(() => vi.advanceTimersByTime(2000));
      expect(screen.getByText('11:36')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
