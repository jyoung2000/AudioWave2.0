import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { AvatarIcon, type AvatarIconId } from '../icons/avatars.js';

export type AvatarSource = { kind: 'builtin'; iconId: string } | { kind: 'image'; src: string };

export interface AvatarProps {
  source: AvatarSource;
  size?: number;
  alt?: string;
  className?: string;
}

export function Avatar({ source, size = 20, alt = '', className }: AvatarProps) {
  return (
    <span className={['aqua-avatar', className].filter(Boolean).join(' ')} style={{ '--aqua-avatar-size': `${size}px` } as React.CSSProperties} role={alt ? 'img' : undefined} aria-label={alt || undefined} aria-hidden={alt ? undefined : true}>
      {source.kind === 'image' ? <img src={source.src} alt="" /> : <AvatarIcon id={source.iconId as AvatarIconId} />}
    </span>
  );
}

export interface AvatarButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  source: AvatarSource;
  label: string;
  size?: number;
}

/** Profile button in the toolbar; ≥32 px hit target through padding on the wrapper. */
export const AvatarButton = forwardRef<HTMLButtonElement, AvatarButtonProps>(function AvatarButton({ source, label, size = 20, className, type = 'button', ...rest }, ref) {
  return (
    <button ref={ref} type={type} className={['aqua-icon-button', className].filter(Boolean).join(' ')} data-variant="plain" aria-label={label} title={label} {...rest}>
      <span className="aqua-icon-button__face" style={{ width: 'auto', height: 'auto', background: 'none', border: 0, boxShadow: 'none' }}>
        <Avatar source={source} size={size} />
      </span>
    </button>
  );
});
