import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Sheet } from '../../src/components/Sheet.js';
import { Button } from '../../src/components/Button.js';
import { TextField } from '../../src/components/TextField.js';
import './setup.js';

describe('Sheet', () => {
  it('traps focus, cancels on Escape, activates the default on Enter and restores focus', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    function Demo() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>New Playlist…</Button>
          <Sheet open={open} title="New Playlist" message="Enter a name." onCancel={() => setOpen(false)} actions={[{ id: 'cancel', label: 'Cancel', onSelect: () => setOpen(false) }, { id: 'create', label: 'Create', variant: 'default', onSelect: () => { onCreate(); setOpen(false); } }]}>
            <TextField label="Name" defaultValue="Playlist" />
          </Sheet>
        </>
      );
    }
    render(<Demo />);
    const opener = screen.getByRole('button', { name: 'New Playlist…' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'New Playlist' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab();
    await user.tab();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    await user.click(opener);
    screen.getByRole('textbox', { name: 'Name' }).focus();
    await user.keyboard('{Enter}');
    expect(onCreate).toHaveBeenCalled();
  });
});

/**
 * "Internal panes do not all cast independent card shadows", which `docs/AQUA_CONFORMANCE.md` cites
 * to this file and which nothing here checked.
 *
 * The rule is about depth meaning something. One surface lifts off the window — the sheet — and
 * everything inside it is grouped by a hairline and a fill, not by another drop shadow. Panes
 * that each cast their own shadow read as a pile of cards rather than as one dialog with parts.
 *
 * Asserted against the stylesheet rather than `getComputedStyle`, because these tests run without
 * the stylesheet attached and a computed value of `''` would pass while proving nothing.
 */
describe('§ depth', () => {
  const css = readFileSync(join(process.cwd(), 'packages', 'aqua-ui', 'src', 'styles', 'aqua.css'), 'utf8');

  /**
   * Every rule whose selector mentions this class, with its declarations.
   *
   * Scanned rather than matched with a regular expression: a selector may contain almost anything,
   * and a pattern built by interpolating a class name into one is a way to look thorough and match
   * nothing.
   */
  function rulesFor(className: string): string[] {
    const out: string[] = [];
    let index = 0;
    while (index < css.length) {
      const open = css.indexOf('{', index);
      if (open === -1) break;
      const close = css.indexOf('}', open);
      if (close === -1) break;
      const previous = Math.max(css.lastIndexOf('}', open), css.lastIndexOf('{', open - 1));
      const selector = css.slice(previous + 1, open);
      if (selector.includes(`.${className}`)) out.push(css.slice(open + 1, close));
      index = close + 1;
    }
    return out;
  }

  it('gives an internal pane a hairline and a fill, and no drop shadow of its own', () => {
    render(
      <div className="aqua-panel">
        <section className="aqua-panel__section">
          <section className="aqua-panel__section">Nested</section>
        </section>
      </div>,
    );
    // The markup really does nest, which is the case the rule is about.
    expect(document.querySelectorAll('.aqua-panel__section .aqua-panel__section').length).toBe(1);

    const declarations = rulesFor('aqua-panel__section');
    expect(declarations.length).toBeGreaterThan(0);
    for (const block of declarations) {
      // An inset shadow is a groove, not a card; a drop shadow is the thing being ruled out.
      const shadows = [...block.matchAll(/box-shadow:\s*([^;]+)/g)].map((m) => m[1]!.trim());
      for (const shadow of shadows) {
        expect(shadow.startsWith('inset') || shadow === 'none', `.aqua-panel__section casts ${shadow}`).toBe(true);
      }
    }
    // It is grouped the way the rule says instead: a hairline and a fill.
    expect(declarations.join(' ')).toMatch(/border:\s*1px/);
    expect(declarations.join(' ')).toMatch(/background:/);
  });

  it('keeps the lift for the one surface that leaves the window', () => {
    // The sheet is what rises; that is what makes the panes inside it read as parts.
    expect(css).toMatch(/--aqua-panel-shadow:/);
    const lifted = ['aqua-sheet'].filter((name) => rulesFor(name).some((block) => block.includes('--aqua-panel-shadow')));
    expect(lifted.length, 'no overlay uses the panel shadow, so nothing lifts off the window').toBeGreaterThan(0);
  });
});
