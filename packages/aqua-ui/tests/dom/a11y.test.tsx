import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import axe from 'axe-core';
import { Gallery } from '../../gallery/Gallery.js';
import './setup.js';

/**
 * axe-core runs against the happy-dom render of the whole gallery. happy-dom lacks layout, so rules
 * that depend on computed geometry/colour (color-contrast, target-size) are disabled here and covered by the
 * Playwright axe runs in music-player/tests/e2e. Everything structural (names, roles, aria attributes, list
 * semantics, landmarks) is asserted here.
 */
describe('accessibility (axe-core, structural rules)', () => {
  it('has no serious or critical violations across the gallery', async () => {
    const { container } = render(<Gallery />);
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false }, 'target-size': { enabled: false }, region: { enabled: false }, 'scrollable-region-focusable': { enabled: false } },
      resultTypes: ['violations'],
    });
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    if (serious.length) {
      console.error(JSON.stringify(serious.map((v) => ({ id: v.id, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.html) })), null, 2));
    }
    expect(serious).toHaveLength(0);
  }, 60_000);
});
