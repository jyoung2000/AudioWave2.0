import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SegmentedControl } from '../../src/components/SegmentedControl.js';
import { ProgressBar } from '../../src/components/ProgressBar.js';
import { Slider } from '../../src/components/Slider.js';
import { IconButton } from '../../src/components/IconButton.js';
import { Button } from '../../src/components/Button.js';
import { TextField } from '../../src/components/TextField.js';
import { Checkbox } from '../../src/components/Checkbox.js';
import { Sheet } from '../../src/components/Sheet.js';
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

describe('Slider', () => {
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
 * "Destructive actions clearly worded and separated", which `docs/AQUA_CONFORMANCE.md` cites to
 * this file. The library's place for a destructive choice is a sheet's left-hand group: apart from
 * the default action, and marked so the stylesheet can colour it rather than the markup.
 */
describe('§ destructive actions', () => {
  function Confirm({ onRemove = () => undefined, onCancel = () => undefined }: { onRemove?: () => void; onCancel?: () => void }) {
    return (
      <Sheet
        open
        standalone
        title="Remove “Road Trip”?"
        message="The playlist will be removed. Songs stay in your library."
        onCancel={onCancel}
        leftActions={[{ id: 'remove', label: 'Remove Playlist', variant: 'destructive', onSelect: onRemove }]}
        actions={[{ id: 'cancel', label: 'Cancel', variant: 'default', onSelect: onCancel }]}
      />
    );
  }

  it('marks the destructive action, separates it from the default, and words it as what it does', () => {
    render(<Confirm />);
    const destructive = screen.getByRole('button', { name: 'Remove Playlist' });
    const safe = screen.getByRole('button', { name: 'Cancel' });

    // Named by an attribute, so the colour lives in the stylesheet rather than in the markup.
    expect(destructive.getAttribute('data-variant')).toBe('destructive');
    expect(safe.getAttribute('data-variant')).toBeNull();
    // Never the default: Enter belongs to the safe answer.
    expect(destructive.getAttribute('data-default')).toBeNull();
    expect(safe.getAttribute('data-default')).toBe('true');
    // Separated: its own group, on the other side of a split row from the default action.
    expect(destructive.parentElement).not.toBe(safe.parentElement);
    expect(destructive.closest('.aqua-sheet__actions')?.classList.contains('aqua-sheet__actions--split')).toBe(true);
    // Worded as the consequence, not "OK".
    expect(destructive.textContent).toMatch(/Remove/);
  });

  it('leaves an ordinary action unmarked, and Escape takes the safe way out', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const onCancel = vi.fn();
    render(<Confirm onRemove={onRemove} onCancel={onCancel} />);
    expect(screen.getByRole('button', { name: 'Cancel' }).getAttribute('data-variant')).toBeNull();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });
});
