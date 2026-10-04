/**
 * The served shell: the player as it is served, photographed.
 *
 * The player serves `music-player/index.html`, generated from the Airwave design (DEC-019). It is
 * one large document with its own scripts, so the guide shows it the only honest way it can: as
 * screenshots taken from the production build by `scripts/styleguide-shell-shots.mjs`
 * (`pnpm styleguide:shell`). `shots.json` records the hash of the shell they were taken from, and
 * `pnpm styleguide:check` fails when the shell has changed since, so these cannot quietly go stale.
 */
import record from './shell/shots.json';
import desktopNowPlaying from './shell/player-desktop-now-playing.png';
import desktopRadio from './shell/player-desktop-radio.png';
import desktopLiveTv from './shell/player-desktop-live-tv.png';
import desktopSettings from './shell/player-desktop-settings.png';
import phoneNowPlaying from './shell/player-phone-now-playing.png';
import phoneRadio from './shell/player-phone-radio.png';
import phoneLiveTv from './shell/player-phone-live-tv.png';
import phoneSettings from './shell/player-phone-settings.png';

const VIEWS: ReadonlyArray<{ id: string; title: string; caption: string; desktop: string; phone: string }> = [
  {
    id: 'now-playing',
    title: 'Music, playing',
    caption: 'Eight songs added through the shell’s own import path, Gantry playing: the jewel case on the stage, the iPod rail, the transport, and the iTunes 10 list with the playing row selected.',
    desktop: desktopNowPlaying,
    phone: phoneNowPlaying,
  },
  {
    id: 'radio',
    title: 'Radio',
    caption: 'The station directory unreachable, so the bundled stations for the nearest city show; the hero becomes the radar while the song keeps playing.',
    desktop: desktopRadio,
    phone: phoneRadio,
  },
  {
    id: 'live-tv',
    title: 'Live TV',
    caption: 'Channels and guide from the companion’s helper on this machine (with no companion, a paired hub’s copy fills the same guide): the QuickTime bar over the picture, Now and Next from the guide, and “Live” where a channel has none.',
    desktop: desktopLiveTv,
    phone: phoneLiveTv,
  },
  {
    id: 'settings',
    title: 'Settings',
    caption: 'Settings is a page with its own address. On a desktop it opens on Statistics with the section tabs across the top; on a phone it opens on the list of sections.',
    desktop: desktopSettings,
    phone: phoneSettings,
  },
];

export function ShellShots() {
  const desktop = record.viewports.find((v) => v.id === 'desktop');
  const phone = record.viewports.find((v) => v.id === 'phone');
  return (
    <>
      <p className="sg__note">
        Taken {new Date(record.takenAt).toISOString().slice(0, 10)} from <code>{record.source}</code> (shell <code>{record.sourceHash}</code>) by <code>pnpm styleguide:shell</code>, at{' '}
        {desktop?.width} × {desktop?.height} and {phone?.width} × {phone?.height}. Nothing reached the network: outside hosts were refused, and the companion’s helper was answered by
        the script.
      </p>
      {VIEWS.map((view) => (
        <figure key={view.id} className="sg-shell" id={`shell-${view.id}`}>
          <figcaption>
            <b>{view.title}</b> {view.caption}
          </figcaption>
          <div className="sg-shell__pair">
            <img className="sg-shell__desktop" src={view.desktop} width={desktop?.width} height={desktop?.height} alt={`The player’s ${view.title} at ${desktop?.width} × ${desktop?.height}`} />
            <img className="sg-shell__phone" src={view.phone} width={phone?.width} height={phone?.height} alt={`The player’s ${view.title} at ${phone?.width} × ${phone?.height}`} />
          </div>
        </figure>
      ))}
    </>
  );
}
