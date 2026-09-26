import { describe, expect, it } from 'vitest';
import { cleanVideoTitle, splitFeatured } from '../../src/titles.js';

describe('splitFeatured', () => {
  it.each([
    ['Song (feat. Guest)', 'Song', ['Guest']],
    ['Song ft. A & B', 'Song', ['A', 'B']],
    ['Song (featuring A, B and C)', 'Song', ['A', 'B', 'C']],
    ['Song [Feat. Guest]', 'Song', ['Guest']],
    ['Song', 'Song', []],
  ])('%s', (input, title, featured) => {
    expect(splitFeatured(input)).toEqual({ title, featured });
  });
});

describe('cleanVideoTitle', () => {
  it.each([
    [{ title: 'Artist - Song (feat. X) [Official Video]', channel: 'SomeLabelVEVO' }, { artist: 'Artist', title: 'Song', featured: ['X'] }],
    [{ title: 'Song (Official Music Video)', channel: 'Artist - Topic' }, { artist: 'Artist', title: 'Song', featured: [] }],
    [{ title: 'Artist – Song (Lyrics) HD', channel: 'LyricsChannel' }, { artist: 'Artist', title: 'Song', featured: [] }],
    [{ title: 'Artist "Song" (Official Audio) 4K', channel: 'Artist' }, { artist: 'Artist', title: 'Song', featured: [] }],
    [{ title: 'Song | Artist', channel: 'Music Weekly' }, { artist: 'Artist', title: 'Song', featured: [] }],
    [{ title: 'Just A Title', channel: 'Random Channel' }, { artist: null, title: 'Just A Title', featured: [] }],
  ])('%j', (input, expected) => {
    const out = cleanVideoTitle(input);
    expect({ artist: out.artist, title: out.title, featured: out.featured }).toEqual(expected);
  });

  it('says when the artist came from a Topic channel', () => {
    expect(cleanVideoTitle({ title: 'Song', channel: 'Artist - Topic' }).fromTopicChannel).toBe(true);
    expect(cleanVideoTitle({ title: 'Artist - Song', channel: 'X' }).fromTopicChannel).toBe(false);
  });
});
