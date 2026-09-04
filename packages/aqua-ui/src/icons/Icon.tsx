import type { SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Optional accessible name; icons are decorative (aria-hidden) unless a title is provided. */
  title?: string;
  size?: number | string;
}

export function svgProps({ title, size, className, ...rest }: IconProps, kind: 'glyph' | 'source'): SVGProps<SVGSVGElement> {
  const dimension = size ?? undefined;
  return {
    className: ['aqua-icon', kind === 'glyph' ? 'aqua-icon--glyph' : 'aqua-icon--source', className].filter(Boolean).join(' '),
    focusable: 'false',
    'aria-hidden': title ? undefined : true,
    role: title ? 'img' : undefined,
    width: dimension,
    height: dimension,
    ...rest,
  };
}
