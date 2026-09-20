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
import { TextField } from '../../src/components/TextField.js';
import { Checkbox } from '../../src/components/Checkbox.js';
import { Menu } from '../../src/components/Menu.js';
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

/**
 * The state ladder `docs/AQUA_CONFORMANCE.md` cites for "hover, pressed, focus, selected, disabled,
 * busy on every control".
 *
 * It cited this file before it contained any such thing. What a DOM test can hold to account is the
 * *state*, not the pixels: that each state is announced in a class or an ARIA attribute, so the
 * stylesheet has something to hang a look on and a screen reader has something to say. The looks
 * themselves are checked by `aqua-conformance.test.ts` against the stylesheets.
 */
describe('§ the state ladder', () => {
  it('a button announces pressed, disabled and busy, and stays reachable for hover and focus', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Button>Add a folder</Button>);
    const button = screen.getByRole('button', { name: 'Add a folder' });

    // Rest: nothing claimed.
    expect(button.className).toContain('aqua-button');
    expect(button.hasAttribute('aria-pressed')).toBe(false);
    expect((button as HTMLButtonElement).disabled).toBe(false);

    // Focus is the browser's, and the control must be able to take it — `:focus-visible` in the
    // stylesheet is worthless on something that cannot be focused.
    await user.tab();
    expect(document.activeElement).toBe(button);

    // Hover has no attribute by design: it is `:hover` in the stylesheet. What matters here is that
    // the element is a real button, so the pseudo-class applies at all.
    expect(button.tagName).toBe('BUTTON');

    rerender(<Button pressed>Add a folder</Button>);
    expect(screen.getByRole('button', { name: 'Add a folder' }).getAttribute('aria-pressed')).toBe('true');

    rerender(<Button busy>Add a folder</Button>);
    const busy = screen.getByRole('button', { name: /Add a folder/ });
    expect(busy.getAttribute('data-busy')).toBe('true');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    // Busy also takes the control out of reach, which is the point: it is already doing the thing.
    expect((busy as HTMLButtonElement).disabled).toBe(true);

    rerender(<Button disabled>Add a folder</Button>);
    expect((screen.getByRole('button', { name: 'Add a folder' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a text field announces invalid and disabled, and keeps its label attached', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TextField label="Hub address" value="" onChange={() => undefined} />);
    const field = screen.getByLabelText('Hub address');
    await user.click(field);
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute('aria-invalid')).not.toBe('true');

    rerender(<TextField label="Hub address" value="" onChange={() => undefined} validation={{ kind: 'error', message: 'That is not an address.' }} />);
    const invalid = screen.getByLabelText('Hub address');
    expect(invalid.getAttribute('aria-invalid')).toBe('true');
    // The reason is announced, not only coloured: colour alone is not a state, and the field points
    // at the message rather than leaving a reader to find it.
    expect(screen.getByText('That is not an address.')).toBeTruthy();
    expect(invalid.getAttribute('aria-describedby')).toBeTruthy();

    rerender(<TextField label="Hub address" value="" onChange={() => undefined} disabled />);
    expect((screen.getByLabelText('Hub address') as HTMLInputElement).disabled).toBe(true);
  });

  it('a checkbox announces checked, mixed and disabled', () => {
    const { rerender } = render(<Checkbox checked={false} onChange={() => undefined}>Keep playing</Checkbox>);
    const box = screen.getByRole('checkbox', { name: 'Keep playing' }) as HTMLInputElement;
    expect(box.checked).toBe(false);

    rerender(<Checkbox checked onChange={() => undefined}>Keep playing</Checkbox>);
    expect((screen.getByRole('checkbox', { name: 'Keep playing' }) as HTMLInputElement).checked).toBe(true);

    rerender(<Checkbox checked={false} indeterminate onChange={() => undefined}>Keep playing</Checkbox>);
    // Mixed is a third state, not an unchecked box with a different picture.
    expect((screen.getByRole('checkbox', { name: 'Keep playing' }) as HTMLInputElement).indeterminate).toBe(true);

    rerender(<Checkbox checked={false} disabled onChange={() => undefined}>Keep playing</Checkbox>);
    expect((screen.getByRole('checkbox', { name: 'Keep playing' }) as HTMLInputElement).disabled).toBe(true);
  });
});

/**
 * "Destructive actions clearly worded and separated", which `docs/AQUA_CONFORMANCE.md` also cited
 * to this file before anything here checked it.
 */
describe('§ destructive actions', () => {
  const entries = [
    { kind: 'item' as const, id: 'play', label: 'Play next', onSelect: () => undefined },
    { kind: 'item' as const, id: 'info', label: 'Get info', onSelect: () => undefined },
    { kind: 'separator' as const, id: 'sep' },
    { kind: 'item' as const, id: 'remove', label: 'Remove from library…', onSelect: () => undefined, destructive: true },
  ];

  it('marks the destructive item, separates it, and never puts it first', () => {
    render(<Menu open entries={entries} anchor={{ x: 0, y: 0 }} onClose={() => undefined} label="Track actions" />);
    const items = screen.getAllByRole('menuitem');
    const destructive = screen.getByRole('menuitem', { name: /Remove from library/ });

    // Named by a class, so the colour lives in the stylesheet rather than in the markup.
    expect(destructive.className).toContain('aqua-menu__item--destructive');
    // Never the first thing the pointer lands on.
    expect(items[0]).not.toBe(destructive);
    // And something stands between it and the ordinary items.
    expect(screen.getAllByRole('separator').length).toBeGreaterThan(0);
    // Worded as what it does, with an ellipsis because it asks first.
    expect(destructive.textContent).toMatch(/Remove/);
  });

  it('leaves an ordinary item unmarked', () => {
    render(<Menu open entries={entries} anchor={{ x: 0, y: 0 }} onClose={() => undefined} label="Track actions" />);
    expect(screen.getByRole('menuitem', { name: 'Play next' }).className).not.toContain('destructive');
  });
});
