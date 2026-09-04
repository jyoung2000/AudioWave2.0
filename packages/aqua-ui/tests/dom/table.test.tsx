import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AquaTable, type ColumnDef } from '../../src/components/AquaTable.js';
import './setup.js';

interface Row { id: string; title: string; time: string }
const rows: Row[] = [{ id: 'a', title: 'Alpha', time: '3:01' }, { id: 'b', title: 'Beta', time: '2:59' }, { id: 'c', title: 'Gamma', time: '4:10' }];
const columns: ColumnDef<Row>[] = [
  { id: 'title', header: 'Name', sortable: true, primary: true, cell: (r) => r.title },
  { id: 'time', header: 'Time', sortable: true, align: 'right', cell: (r) => r.time },
];

describe('AquaTable', () => {
  it('renders a real table with sortable headers exposing aria-sort', async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    render(<AquaTable columns={columns} rows={rows} rowKey={(r) => r.id} label="Songs" sort={{ columnId: 'title', direction: 'ascending' }} onSortChange={onSort} />);
    const table = screen.getByRole('table', { name: 'Songs' });
    const headers = within(table).getAllByRole('columnheader');
    expect(headers[0]!.getAttribute('aria-sort')).toBe('ascending');
    expect(headers[1]!.getAttribute('aria-sort')).toBe('none');
    await user.click(within(headers[0]!).getByRole('button'));
    expect(onSort).toHaveBeenCalledWith('title', 'descending');
    await user.click(within(headers[1]!).getByRole('button'));
    expect(onSort).toHaveBeenCalledWith('time', 'ascending');
  });

  it('uses a roving tabindex, arrow navigation, Space selection and Enter activation', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onSelection = vi.fn();
    render(<AquaTable columns={columns} rows={rows} rowKey={(r) => r.id} label="Songs" onActivate={onActivate} onSelectionChange={onSelection} />);
    const bodyRows = screen.getAllByRole('row').slice(1);
    expect(bodyRows.filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1);
    bodyRows[0]!.focus();
    await user.keyboard('{ArrowDown}');
    await new Promise((r) => setTimeout(r, 20));
    expect(document.activeElement).toBe(bodyRows[1]);
    await user.keyboard(' ');
    expect(onSelection).toHaveBeenCalled();
    expect(bodyRows[1]!.getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Enter}');
    expect(onActivate).toHaveBeenCalledWith(rows[1]);
  });

  it('marks the current row and shows an empty message', () => {
    const { rerender } = render(<AquaTable columns={columns} rows={rows} rowKey={(r) => r.id} label="Songs" currentKey="c" />);
    expect(screen.getAllByRole('row')[3]!.getAttribute('aria-current')).toBe('true');
    rerender(<AquaTable columns={columns} rows={[]} rowKey={(r) => r.id} label="Songs" emptyMessage="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeTruthy();
  });
});
