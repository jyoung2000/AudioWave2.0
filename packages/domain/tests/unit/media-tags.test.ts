import { describe, expect, it } from 'vitest';
import { artistTag, cleanTags, isoDate, releaseDateOf, ytDlpMetaFields } from '../../src/media-tags.js';

describe('isoDate', () => {
  it.each([
    ['20091025', '2009-10-25'],
    ['2009-10-25', '2009-10-25'],
    ['2009/10/25', '2009-10-25'],
    ['2009-10-25T00:00:00Z', '2009-10-25'],
    ['1987-11', '1987-11'],
    ['198711', '1987-11'],
  ])('%s → %s', (input, expected) => {
    expect(isoDate(input)).toBe(expected);
  });

  it.each([['1987'], ['20091325'], ['20090230'], ['0999-01-01'], ['next tuesday'], [''], [20091025], [null], [undefined]])('%j is not a date', (input) => {
    expect(isoDate(input)).toBeNull();
  });
});

describe('releaseDateOf', () => {
  it('takes the date tag first, then the release date, then the original release date', () => {
    expect(releaseDateOf({ date: '2014-11-10', releasedate: '2014-01-01', originaldate: '2008-05-20' })).toBe('2014-11-10');
    expect(releaseDateOf({ date: '2014', releasedate: '2014-01-02', originaldate: '2008-05-20' })).toBe('2014-01-02');
    expect(releaseDateOf({ originaldate: '2008-05-20' })).toBe('2008-05-20');
    expect(releaseDateOf({ date: '2014' })).toBeNull();
    expect(releaseDateOf({})).toBeNull();
  });

  it('puts an MP3’s ID3v2.3 year and day back together, the way FFmpeg wrote them (TYER + TDAT, DDMM)', () => {
    // The frames music-metadata reported for the real Big Buck Bunny MP3 the helper fetched on 2026-10-04.
    const native = { 'ID3v2.3': [{ id: 'TIT2', value: 'Big Buck Bunny' }, { id: 'TYER', value: '2014' }, { id: 'TDAT', value: '1011' }] };
    expect(releaseDateOf({}, native)).toBe('2014-11-10');
    expect(releaseDateOf({}, { 'ID3v2.2': [{ id: 'TYE', value: '1999' }, { id: 'TDA', value: '3112' }] })).toBe('1999-12-31');
    expect(releaseDateOf({}, { 'ID3v2.3': [{ id: 'TYER', value: '2014' }] })).toBeNull();
    expect(releaseDateOf({}, { 'ID3v2.3': [{ id: 'TYER', value: '2014' }, { id: 'TDAT', value: '3102' }] })).toBeNull();
    // A tag that says the whole date wins over the pieces.
    expect(releaseDateOf({ date: '2020-01-02' }, native)).toBe('2020-01-02');
  });
});

describe('cleanTags', () => {
  it('cleans a YouTube video and falls back to the channel when the title names no artist', () => {
    expect(cleanTags({ title: 'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film', channel: 'Blender', extractor_key: 'Youtube', upload_date: '20141110' })).toEqual({
      title: 'Big Buck Bunny',
      artist: 'Blender',
      featured: [],
      album: null,
      genre: null,
      date: '2014-11-10',
      year: 2014,
      trackNumber: null,
    });
  });

  it('believes a source that names the track, and splits its features off', () => {
    expect(cleanTags({ title: 'whatever', track: 'Song (feat. Guest)', artists: ['Main', 'Other'], album: 'LP', genres: ['Pop'], release_date: '20200102', upload_date: '20210101', track_number: 3 })).toMatchObject({
      title: 'Song',
      artist: 'Main',
      featured: ['Other', 'Guest'],
      album: 'LP',
      genre: 'Pop',
      date: '2020-01-02',
      trackNumber: 3,
    });
  });

  it('takes the artist off the front of a title that repeats it', () => {
    // A SoundCloud set entry, as yt-dlp described it on 2026-10-04.
    expect(cleanTags({ title: 'The Royal Concept - Gimme Twice', track: 'The Royal Concept - Gimme Twice', artist: 'The Royal Concept', uploader: 'The Royal Concept' })).toMatchObject({ title: 'Gimme Twice', artist: 'The Royal Concept' });
    expect(cleanTags({ title: 'Some (Band) – Song', artist: 'Some (Band)' })).toMatchObject({ title: 'Song' });
    expect(cleanTags({ title: 'Song - Remix', artist: 'Band' })).toMatchObject({ title: 'Song - Remix' });
  });

  it('keeps the year when that is all there is', () => {
    expect(cleanTags({ title: 'A', uploader: 'B', release_year: 1999 })).toMatchObject({ date: null, year: 1999 });
  });

  it('never lists the main artist as a feature too', () => {
    expect(cleanTags({ title: 'x', track: 'Song', artists: ['Main', 'main'] }).featured).toEqual([]);
  });
});

describe('the tags written', () => {
  it('spells features the conventional way', () => {
    expect(artistTag('A', [])).toBe('A');
    expect(artistTag('A', ['B'])).toBe('A feat. B');
    expect(artistTag('A', ['B', 'C'])).toBe('A feat. B & C');
    expect(artistTag(null, [])).toBeNull();
  });

  it('becomes yt-dlp meta_ fields, with an empty genre rather than a site category', () => {
    expect(ytDlpMetaFields({ title: 'T', artist: 'A', featured: ['B'], album: null, genre: null, date: '2009-10-25', year: 2009, trackNumber: null })).toEqual({
      meta_title: 'T',
      meta_artist: 'A feat. B',
      meta_album_artist: 'A',
      meta_genre: '',
      meta_date: '2009-10-25',
    });
    expect(ytDlpMetaFields({ title: 'T', artist: null, featured: [], album: 'LP', genre: 'Jazz', date: null, year: 1960, trackNumber: null })).toEqual({ meta_title: 'T', meta_album: 'LP', meta_genre: 'Jazz', meta_date: '1960' });
  });
});
