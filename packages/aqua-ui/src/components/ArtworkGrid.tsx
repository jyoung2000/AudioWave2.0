import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Glyph } from '../icons/glyphs.js';

export interface ArtworkTile {
  id: string;
  title: string;
  subtitle?: string | null;
  artworkUrl?: string | null;
  placeholder?: ReactNode;
}

export interface ArtworkGridProps {
  tiles: ArtworkTile[];
  label: string;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onActivate?: (id: string) => void;
  onPlay?: (id: string) => void;
  tileSize?: number;
  className?: string;
}

/** Square original artwork, compact labels, selection frame + label highlight, hover play overlay (click it, or Shift+Enter, to play), keyboard grid navigation (spec §9.10). */
export function ArtworkGrid({ tiles, label, selectedId, onSelect, onActivate, onPlay, tileSize = 128, className }: ArtworkGridProps) {
  const [focusIndex, setFocusIndex] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);
  const columns = () => {
    const el = listRef.current;
    if (!el) return 1;
    const style = getComputedStyle(el);
    return Math.max(1, style.gridTemplateColumns.split(' ').length);
  };
  const focus = (index: number) => {
    const i = Math.max(0, Math.min(tiles.length - 1, index));
    setFocusIndex(i);
    listRef.current?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>, index: number) => {
    const cols = columns();
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); focus(index + 1); break;
      case 'ArrowLeft': e.preventDefault(); focus(index - 1); break;
      case 'ArrowDown': e.preventDefault(); focus(index + cols); break;
      case 'ArrowUp': e.preventDefault(); focus(index - cols); break;
      case 'Home': e.preventDefault(); focus(0); break;
      case 'End': e.preventDefault(); focus(tiles.length - 1); break;
      case 'Enter':
        e.preventDefault();
        if (e.shiftKey && onPlay) onPlay(tiles[index]!.id);
        else onActivate?.(tiles[index]!.id);
        break;
      case ' ': e.preventDefault(); onSelect?.(tiles[index]!.id); break;
      default: break;
    }
  };
  return (
    <ul ref={listRef} className={['aqua-grid', className].filter(Boolean).join(' ')} role="listbox" aria-label={label} style={{ '--aqua-tile': `${tileSize}px` } as React.CSSProperties}>
      {tiles.map((t, i) => (
        <li
          key={t.id}
          className="aqua-tile"
          role="option"
          aria-selected={t.id === selectedId}
          aria-label={t.subtitle ? `${t.title}, ${t.subtitle}` : t.title}
          data-index={i}
          tabIndex={i === focusIndex ? 0 : -1}
          onClick={(e) => {
            setFocusIndex(i);
            if (onPlay && (e.target as HTMLElement).closest('[data-play]')) {
              onPlay(t.id);
              return;
            }
            onSelect?.(t.id);
          }}
          onDoubleClick={() => onActivate?.(t.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          <div className="aqua-tile__art">
            {t.artworkUrl ? <img src={t.artworkUrl} alt="" loading="lazy" width={tileSize} height={tileSize} /> : <span className="aqua-tile__placeholder" aria-hidden="true">{t.placeholder ?? <Glyph name="note" />}</span>}
            {onPlay ? (
              <span className="aqua-tile__play" aria-hidden="true" data-play>
                <Glyph name="play" />
              </span>
            ) : null}
          </div>
          <div className="aqua-tile__title" title={t.title}>{t.title}</div>
          {t.subtitle ? <div className="aqua-tile__sub" title={t.subtitle}>{t.subtitle}</div> : null}
        </li>
      ))}
    </ul>
  );
}
