/*
 * Only the shared half of the stylesheet loads from here: tokens, base, and the controls every
 * product renders. The three chrome stylesheets are imported by the products that actually draw
 * that chrome, because CSS does not tree-shake and a product should not carry rules for markup it
 * never produces:
 *
 *   @now-playing/aqua-ui/window.css        window frame, work area, source list, bottom bar
 *   @now-playing/aqua-ui/media.css         toolbar transport, LCD, scrubber, search, results
 *   @now-playing/aqua-ui/now-playing.css   the 2010 page: status bar, hero, iTunes 10 list
 *
 * The player is a page and loads the third; the hub's admin GUI is a window and loads the first.
 * The bundle budget in `tests/perf` is what turned this from a preference into a rule.
 */
import './styles/aqua.css';

export * from './context.js';
export * from './hooks/index.js';
export * from './icons/index.js';
export * from './components/Button.js';
export * from './components/Spinner.js';
export * from './components/IconButton.js';
export * from './components/Checkbox.js';
export * from './components/TextField.js';
export * from './components/InlineValidation.js';
export * from './components/PopUpMenu.js';
export * from './components/Slider.js';
export * from './components/ProgressBar.js';
export * from './components/SegmentedControl.js';
export * from './components/Badge.js';
export * from './components/Avatar.js';
export * from './components/Window.js';
export * from './components/Toolbar.js';
export * from './components/Transport.js';
export * from './components/LcdDisplay.js';
export * from './components/Scrubber.js';
export * from './components/VolumeSlider.js';
export * from './components/SearchField.js';
export * from './components/ResultsPopover.js';
export * from './components/SourceList.js';
export * from './components/AquaTable.js';
export * from './components/ArtworkGrid.js';
export * from './components/Tabs.js';
export * from './components/Marquee.js';
export * from './components/Sheet.js';
export * from './components/Menu.js';
export * from './components/Toast.js';
export * from './components/States.js';
export * from './components/Panel.js';
export * from './components/PageBar.js';
export * from './components/SectionStrip.js';
export * from './components/Hero.js';

// The page skin's list and stage, shared by the player, the gallery and the styleguide.
export * from './components/MusicList.js';
export * from './components/music-list-behaviours.js';
export * from './components/JewelStage.js';
export * from './lib/track-source.js';
export { mountJewelCase, type JewelCaseAlbum, type JewelCaseHandle, type JewelCaseOptions, type JewelCasePose } from './stage/jewel-case.js';
