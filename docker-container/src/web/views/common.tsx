/**
 * Pieces shared by the admin views.
 *
 * What a list does while loading, when it fails, and when it succeeds with nothing to show is
 * decided in one place, so "empty" never looks like "broken": one quiet line inside the list box
 * (`listState`, `EmptyRow`, `EmptyCells`), and a failed action says what to do in a sentence under
 * the control that failed (`ActionError`). The pieces themselves are part of the window kit in
 * `../ui.tsx`; the views import them from there, and this module is the views' named door to them.
 */
export { ActionError, Ago, EmptyCells, EmptyRow, errorSentence, listState } from '../ui.js';
