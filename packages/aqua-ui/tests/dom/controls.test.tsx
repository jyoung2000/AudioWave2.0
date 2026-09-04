import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SegmentedControl } from '../../src/components/SegmentedControl.js';
import { SearchField } from '../../src/components/SearchField.js';
import { Transport } from '../../src/components/Transport.js';
import { Scrubber } from '../../src/components/Scrubber.js';
import { ProgressBar } from '../../src/components/ProgressBar.js';
import { Slider } from '../../src/components/Slider.js';
import { IconButton } from '../../src/components/IconButton.js';
import { Button } from '../../src/components/Button.js';
import { useState } from 'react';
import './setup.js';

describe('SegmentedControl', () => {
  it('is a radiogroup with one tab stop and arrow-key selection', async () => {
    const user = userEvent.setup();
    function Demo() {
      const [v, setV] = useState('solo');
      return <SegmentedControl label="Listening mode" value={v} onChange={setV} segments={[{ value: 'solo', label: 'Solo', showLabel: true }, { value: 'group', label: 'Group', showLabel: true }]} />;
    }
    render(<Demo />);
    const radios = screen.getAllByRole('radio');
    expect(radios.filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1);
    radios[0]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Group' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Group' }));
  });
});

describe('SearchField', () => {
  it('shows the clear button only with text, Escape clears then closes', async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    function Demo() {
      const [v, setV] = useState('');
      return <SearchField value={v} onChange={setV} onEscape={onEscape} />;
    }
    render(<Demo />);
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    const input = screen.getByRole('searchbox', { name: 'Search' });
    await user.type(input, 'blue');
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect((input as HTMLInputElement).value).toBe('');
    expect(onEscape).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onEscape).toHaveBeenCalled();
  });
});

describe('Transport', () => {
  it('swaps the play/pause name and exposes aria-pressed', async () => {
    const user = userEvent.setup();
    const onPlayPause = vi.fn();
    const { rerender } = render(<Transport playing={false} onPlayPause={onPlayPause} onPrevious={() => undefined} onNext={() => undefined} />);
    const play = screen.getByRole('button', { name: 'Play' });
    expect(play.getAttribute('aria-pressed')).toBe('false');
    await user.click(play);
    expect(onPlayPause).toHaveBeenCalled();
    rerender(<Transport playing onPlayPause={onPlayPause} onPrevious={() => undefined} onNext={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Pause' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('group', { name: 'Playback controls' })).toBeTruthy();
  });
});

describe('Scrubber and sliders', () => {
  it('seeks with the keyboard and exposes aria-valuetext', async () => {
    const user = userEvent.setup();
    const onSeek = vi.fn();
    render(<Scrubber positionMs={10_000} durationMs={200_000} onSeek={onSeek} />);
    const slider = screen.getByRole('slider', { name: 'Seek' });
    expect(slider.getAttribute('aria-valuetext')).toBe('0:10 of 3:20');
    slider.focus();
    await user.keyboard('{ArrowRight}');
    expect(onSeek).toHaveBeenCalledWith(15_000);
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(onSeek).toHaveBeenCalledWith(0);
    await user.keyboard('{End}');
    expect(onSeek).toHaveBeenCalledWith(200_000);
  });
  it('live scrubber is not a slider and shows the LIVE marker', () => {
    render(<Scrubber positionMs={1000} durationMs={null} onSeek={() => undefined} live />);
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('LIVE');
  });
  it('generic slider clamps and supports editable value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Slider label="1 kHz" value={11.5} min={-12} max={12} step={0.5} onChange={onChange} editable unit=" dB" />);
    const slider = screen.getByRole('slider', { name: '1 kHz' });
    slider.focus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(onChange).toHaveBeenLastCalledWith(12);
    const field = screen.getByRole('textbox', { name: '1 kHz value' });
    await user.clear(field);
    await user.type(field, '-3{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(-3);
  });
});

describe('ProgressBar / IconButton / Button', () => {
  it('progress has a name and value; indeterminate is busy with text', () => {
    render(<ProgressBar value={42} label="Importing 18 of 94 songs…" />);
    const bar = screen.getByRole('progressbar', { name: 'Importing 18 of 94 songs…' });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    render(<ProgressBar label="Syncing artwork…" />);
    expect(screen.getByRole('progressbar', { name: 'Syncing artwork…' }).getAttribute('aria-busy')).toBe('true');
  });
  it('icon buttons require names; menu affordance sets aria-haspopup', () => {
    render(<IconButton icon="playlist-add" label="Add to Playlist" menu expanded={false} />);
    const b = screen.getByRole('button', { name: 'Add to Playlist' });
    expect(b.getAttribute('aria-haspopup')).toBe('menu');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(b.getAttribute('title')).toBe('Add to Playlist');
  });
  it('default button carries data-default and ellipsis', () => {
    render(<Button variant="default" ellipsis>Export</Button>);
    const b = screen.getByRole('button', { name: 'Export…' });
    expect(b.getAttribute('data-default')).toBe('true');
  });
});
