import { describe, expect, it } from 'vitest';
import { mapGenreLabel, mergeGenreProfile, topGenre } from '../../src/genres.js';

describe('genre vocabulary', () => {
  it.each([
    ['Hip-Hop', 'hip hop'],
    ['hiphop', 'hip hop'],
    ['Rap/Hip-Hop', 'hip hop'],
    ['R&B', 'r&b'],
    ['RnB', 'r&b'],
    ['Drum & Bass', 'drum and bass'],
    ['DnB', 'drum and bass'],
    ['Alt Rock', 'alternative rock'],
    ['EDM', 'electronic'],
  ])('maps %s to %s', (label, genre) => {
    expect(mapGenreLabel(label)?.genre).toBe(genre);
  });

  it('knows parents', () => {
    expect(mapGenreLabel('trap')).toEqual({ genre: 'trap', parent: 'hip hop' });
    expect(mapGenreLabel('rock')).toEqual({ genre: 'rock', parent: null });
  });

  it('drops labels it does not know', () => {
    expect(mapGenreLabel('summer vibes 2019')).toBeNull();
  });

  it('merges votes into a profile that sums to one, rolling half of a child into its parent', () => {
    const p = mergeGenreProfile([{ label: 'trap', weight: 1 }, { label: 'Hip-Hop', weight: 1 }, { label: 'summer', weight: 1 }]);
    expect(Object.values(p).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    expect(p['hip hop']).toBeGreaterThan(p['trap']!);
    expect(p['summer']).toBeUndefined();
  });

  it('keeps at most six genres and names the top one', () => {
    const votes = ['rock', 'pop', 'jazz', 'blues', 'soul', 'funk', 'disco', 'house'].map((label, i) => ({ label, weight: 8 - i }));
    const p = mergeGenreProfile(votes);
    expect(Object.keys(p)).toHaveLength(6);
    expect(topGenre(p)).toBe('rock');
    expect(topGenre({})).toBeNull();
  });
});
