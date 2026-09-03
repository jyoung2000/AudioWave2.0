import type { WavTags, ToneSpec } from './wav.js';

export interface FixtureTrackSpec {
  file: string;
  tags: Required<Pick<WavTags, 'title' | 'artist' | 'album' | 'genre' | 'year' | 'track'>>;
  tone: ToneSpec;
  /** Folder relative to the fixture root — exercises recursive indexing. */
  folder: string;
}

const A4 = 440;
const note = (semis: number) => A4 * 2 ** (semis / 12);

/** Original synthetic catalogue (no real artists). Short files keep the repo small: 3–5 s each. */
export const FIXTURE_LIBRARY: FixtureTrackSpec[] = [
  { file: '01 Ember Line.wav', folder: 'Fennel Grove/Long Wave Sessions', tags: { title: 'Ember Line', artist: 'Fennel Grove', album: 'Long Wave Sessions', genre: 'Ambient', year: '2019', track: '1' }, tone: { seconds: 4, notes: [[note(0), 1], [note(4), 1], [note(7), 1], [note(12), 1]] } },
  { file: '02 Slow Carousel.wav', folder: 'Fennel Grove/Long Wave Sessions', tags: { title: 'Slow Carousel', artist: 'Fennel Grove', album: 'Long Wave Sessions', genre: 'Ambient', year: '2019', track: '2' }, tone: { seconds: 3, notes: [[note(-5), 1.5], [note(-1), 1.5]] } },
  { file: '03 Paper Harbour.wav', folder: 'Fennel Grove/Long Wave Sessions', tags: { title: 'Paper Harbour', artist: 'Fennel Grove', album: 'Long Wave Sessions', genre: 'Ambient', year: '2019', track: '3' }, tone: { seconds: 3, notes: [[note(2), 1], [note(5), 1], [note(9), 1]] } },
  { file: '01 Signal Fade.wav', folder: 'Cassette Bloom/Live from Pier 9', tags: { title: 'Signal Fade', artist: 'Cassette Bloom', album: 'Live from Pier 9', genre: 'Indie', year: '2021', track: '1' }, tone: { seconds: 4, notes: [[note(-12), 1], [note(-8), 1], [note(-5), 1], [note(0), 1]] } },
  { file: '02 Harbour Lights.wav', folder: 'Cassette Bloom/Live from Pier 9', tags: { title: 'Harbour Lights', artist: 'Cassette Bloom', album: 'Live from Pier 9', genre: 'Indie', year: '2021', track: '2' }, tone: { seconds: 5, notes: [[note(3), 1], [note(7), 1], [note(10), 1], [note(7), 1], [note(3), 1]] } },
  { file: '01 Nine Below.wav', folder: 'Cassette Bloom/Tideline', tags: { title: 'Nine Below', artist: 'Cassette Bloom', album: 'Tideline', genre: 'Indie', year: '2023', track: '1' }, tone: { seconds: 3, notes: [[note(-7), 1.5], [note(-3), 1.5]] } },
  { file: '01 Copper Meridian.wav', folder: 'Orbital Cartographers/Copper Meridian', tags: { title: 'Copper Meridian', artist: 'Orbital Cartographers', album: 'Copper Meridian', genre: 'Electronic', year: '2018', track: '1' }, tone: { seconds: 4, notes: [[note(5), 0.5], [note(9), 0.5], [note(12), 0.5], [note(9), 0.5], [note(5), 0.5], [note(0), 0.5], [note(5), 1]] } },
  { file: '02 Glass Hour.wav', folder: 'Orbital Cartographers/Copper Meridian', tags: { title: 'Glass Hour', artist: 'Orbital Cartographers', album: 'Copper Meridian', genre: 'Electronic', year: '2018', track: '2' }, tone: { seconds: 3, notes: [[note(14), 1], [note(12), 1], [note(9), 1]] } },
  { file: 'Copper Meridian (Radio Edit).wav', folder: 'Orbital Cartographers/Singles', tags: { title: 'Copper Meridian (Radio Edit)', artist: 'Orbital Cartographers', album: 'Copper Meridian (Radio Edit)', genre: 'Electronic', year: '2018', track: '1' }, tone: { seconds: 3, notes: [[note(5), 0.5], [note(9), 0.5], [note(12), 0.5], [note(9), 0.5], [note(5), 1]] } },
  { file: '01 Quiet Arithmetic.wav', folder: 'Marlow & the Tidewater/Quiet Arithmetic', tags: { title: 'Quiet Arithmetic', artist: 'Marlow & the Tidewater', album: 'Quiet Arithmetic', genre: 'Folk', year: '2015', track: '1' }, tone: { seconds: 3, notes: [[note(-2), 1], [note(2), 1], [note(5), 1]] } },
  { file: '02 Lantern Road.wav', folder: 'Marlow & the Tidewater/Quiet Arithmetic', tags: { title: 'Lantern Road', artist: 'Marlow & the Tidewater', album: 'Quiet Arithmetic', genre: 'Folk', year: '2015', track: '2' }, tone: { seconds: 4, notes: [[note(0), 2], [note(7), 2]] } },
  { file: 'Untagged Tone.wav', folder: 'Loose Files', tags: { title: '', artist: '', album: '', genre: '', year: '', track: '' }, tone: { seconds: 2, notes: [[note(0), 2]] } },
];

/** A duplicate of Ember Line placed in a second folder (identical bytes) exercises content-hash dedupe. */
export const FIXTURE_DUPLICATE = { source: '01 Ember Line.wav', folder: 'Loose Files', file: 'Ember Line (copy).wav' } as const;
