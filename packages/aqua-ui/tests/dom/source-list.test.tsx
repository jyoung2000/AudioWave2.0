import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SourceList } from '../../src/components/SourceList.js';
import './setup.js';

const groups = [
  { id: 'lib', label: 'Library', items: [{ id: 'library', label: 'Library' }, { id: 'songs', label: 'Songs' }, { id: 'albums', label: 'Albums' }] },
  { id: 'pl', label: 'Playlists', items: [{ id: 'queue', label: 'Solo Queue' }, { id: 'road', label: 'Road Trip' }] },
];

describe('SourceList', () => {
  it('has one tab stop, moves with arrows, Home/End, selects with Enter and supports type-ahead', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<SourceList groups={groups} selectedId="songs" onSelect={onSelect} />);
    const options = screen.getAllByRole('option');
    expect(options.filter((o) => o.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(screen.getByRole('option', { name: 'Songs' }).getAttribute('aria-selected')).toBe('true');
    screen.getByRole('option', { name: 'Songs' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Albums' }));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Road Trip' }));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Library' }));
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('library');
    await user.keyboard('r');
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Road Trip' }));
  });

  it('collapses and expands groups with Left/Right', async () => {
    const user = userEvent.setup();
    render(<SourceList groups={groups} selectedId="songs" onSelect={() => undefined} />);
    screen.getByRole('option', { name: 'Songs' }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.queryByRole('option', { name: 'Songs' })).toBeNull();
    const heading = screen.getByRole('button', { name: /Library/ });
    expect(heading.getAttribute('aria-expanded')).toBe('false');
    await user.click(heading);
    expect(screen.getByRole('option', { name: 'Songs' })).toBeTruthy();
  });
});
