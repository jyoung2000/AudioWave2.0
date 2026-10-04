/*
 * The component library's public face: exactly what the player's React source imports, and nothing
 * else. The styleguide reads this file to list every component and which product imports it; a
 * component no product imports is removed rather than kept here as legacy.
 *
 * Only the shared stylesheet loads from here: tokens, base, and the controls. The page skin is a
 * separate import, because CSS does not tree-shake and only the player draws that page:
 *
 *   @now-playing/aqua-ui/now-playing.css   the 2010 page: status bar, hero, iTunes 10 list
 *
 * The hub and the companion import none of the components — only the Airwave stylesheets
 * (airwave-window.css, airwave-hub.css) and AquaArt (@now-playing/aqua-ui/airwave-art).
 */
import './styles/aqua.css';
// Design overrides, on top of everything the library ships. Empty by default; see the file's note
// for why its selector is doubled rather than relying on where a product loads it.
import './styles/overrides.css';

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
export * from './components/AquaTable.js';
export * from './components/Sheet.js';
export * from './components/Toast.js';
export * from './components/States.js';
export * from './components/Panel.js';
export * from './components/PageBar.js';
export * from './components/SectionStrip.js';
export * from './components/Hero.js';

// The page skin's list and stage, shared by the player, the gallery and the styleguide. MusicList's
// row menu, marquee and overlay scroller (music-list-behaviours.tsx, Marquee.tsx) are its own parts
// and stay private to it.
export * from './components/MusicList.js';
export * from './components/JewelStage.js';
export * from './lib/track-source.js';
export * from './lib/provider-artwork.js';
export { mountJewelCase, type JewelCaseAlbum, type JewelCaseHandle, type JewelCaseOptions, type JewelCasePose } from './stage/jewel-case.js';
