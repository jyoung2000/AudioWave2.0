import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { Sheet } from '../../src/components/Sheet.js';
import { Menu, useContextMenu } from '../../src/components/Menu.js';
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

describe('Menu', () => {
  it('opens with menu roles, moves with arrows, closes with Escape and restores focus', async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn();
    function Demo() {
      const menu = useContextMenu();
      const ref = useRef<HTMLButtonElement | null>(null);
      return (
        <>
          <Button ref={ref} onClick={() => menu.openAt(ref.current!)}>Open</Button>
          <Menu open={menu.open} anchor={menu.anchor} onClose={menu.close} returnFocusTo={menu.returnFocusTo} label="Song actions" entries={[{ kind: 'item', id: 'play', label: 'Play', onSelect: onPlay }, { kind: 'item', id: 'next', label: 'Play Next', onSelect: () => undefined }, { kind: 'separator', id: 's' }, { kind: 'checkbox', id: 'c', label: 'Starred', checked: true, onToggle: () => undefined }]} />
        </>
      );
    }
    render(<Demo />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    const menu = screen.getByRole('menu', { name: 'Song actions' });
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(2);
    expect(document.activeElement).toBe(items[0]);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);
    expect(screen.getByRole('menuitemcheckbox', { name: 'Starred' }).getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(menu.isConnected).toBe(false);
    await user.click(opener);
    await user.click(screen.getByRole('menuitem', { name: 'Play' }));
    expect(onPlay).toHaveBeenCalled();
  });
});
