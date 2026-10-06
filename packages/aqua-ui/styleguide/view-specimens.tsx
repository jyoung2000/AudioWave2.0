/**
 * The hub's and the companion's own views, running in the guide.
 *
 * Unlike the hand-arranged screens in `./airwave-screens.tsx`, nothing inside a pane here is
 * written for the guide: each section is the product's own view component — `GroupsView`,
 * `BackupView`, `AboutView` and the rest — with its own markup, hooks, words and states. What the
 * guide supplies is what is around them:
 *
 *   - the window frame (`HubWindow`, `CompanionWindow`), which in the products lives in `App.tsx`
 *     together with sign-in and session handling, and wraps each section in the same
 *     `<section id aria-label>` the apps do;
 *   - the server behind them. The views reach their product through one module each — the hub's
 *     API client and the companion's bridge — and the styleguide build swaps exactly those two for
 *     recordings of a real hub and a real companion (`fixtures/`, DEC-030). A read gets what the
 *     real one said; a change is refused with a sentence, which the view shows as it shows any
 *     refused action.
 */
import { useState, type ReactNode } from 'react';
import * as Hub from '../../../docker-container/src/web/ui.js';
import * as Companion from '../../../windows-companion/src/renderer/ui.js';
import { BackupView as HubBackupView } from '../../../docker-container/src/web/views/Backup.js';
import { DiagnosticsView } from '../../../docker-container/src/web/views/Diagnostics.js';
import { DiscordView } from '../../../docker-container/src/web/views/Discord.js';
import { GroupsView } from '../../../docker-container/src/web/views/Groups.js';
import { LibraryView as HubLibraryView } from '../../../docker-container/src/web/views/Library.js';
import { LiveTvView as HubLiveTvView } from '../../../docker-container/src/web/views/LiveTv.js';
import { NetworkView } from '../../../docker-container/src/web/views/Network.js';
import { ProfilesView } from '../../../docker-container/src/web/views/Profiles.js';
import { RecommendationsView } from '../../../docker-container/src/web/views/Recommendations.js';
import { SharesView } from '../../../docker-container/src/web/views/Shares.js';
import { MusicSearchSettingsView } from '../../../docker-container/src/web/views/CatalogSettings.js';
import { SearchView as HubSearchView } from '../../../docker-container/src/web/views/Search.js';
import { SearchView as CompanionSearchView } from '../../../windows-companion/src/renderer/views/Search.js';
import { AboutView } from '../../../windows-companion/src/renderer/views/About.js';
import { BackupView as CompanionBackupView } from '../../../windows-companion/src/renderer/views/Backup.js';
import { SettingsView } from '../../../windows-companion/src/renderer/views/Settings.js';
import { useChannel } from '../../../windows-companion/src/renderer/hooks.js';
import type { TabIconId } from '../../../docker-container/src/web/icons.js';
import { CompanionWindow, HubWindow } from './airwave-screens.js';

/* ====================================================================== hub */

/** What the hub's status strip says about the recorded hub: on this machine only, as it was recorded. */
const HUB_STATUS = 'Airwave Hub running · 127.0.0.1:4546 · reachable from this machine only';

/** One tab of the hub window with the given sections in it, each the hub's own view. */
function HubSections({ tab, sections }: { tab: TabIconId; sections: ReadonlyArray<{ id: string; title: string; view: ReactNode }> }) {
  return (
    <Hub.HubUiProvider gated={false}>
      {({ message, sheet }) => (
        <HubWindow tab={tab} dot="ok" status={message ?? HUB_STATUS} counts="0 connected · 0 playing" sheet={sheet}>
          {sections.map((section) => (
            <section key={section.id} id={section.id} aria-label={section.title}>
              {section.view}
            </section>
          ))}
        </HubWindow>
      )}
    </Hub.HubUiProvider>
  );
}

export const HubGroupsScreen = () => <HubSections tab="groups" sections={[{ id: 'groups', title: 'Groups', view: <GroupsView /> }]} />;
export const HubLibraryScreen = () => <HubSections tab="music" sections={[{ id: 'library', title: 'Library', view: <HubLibraryView /> }]} />;
/** In the hub, Live TV is drawn straight after Downloads, inside that section; here it is shown on its own. */
export const HubLiveTvScreen = () => <HubSections tab="music" sections={[{ id: 'downloads', title: 'Downloads', view: <HubLiveTvView /> }]} />;
export const HubRecommendationsScreen = () => <HubSections tab="music" sections={[{ id: 'recommendations', title: 'Recommendations', view: <RecommendationsView /> }]} />;
export const HubProfilesScreen = () => <HubSections tab="devices" sections={[{ id: 'profiles', title: 'Profiles', view: <ProfilesView /> }]} />;
export const HubSharesScreen = () => <HubSections tab="sharing" sections={[{ id: 'shares', title: 'Shared links', view: <SharesView /> }]} />;
export const HubDiscordScreen = () => <HubSections tab="sharing" sections={[{ id: 'discord', title: 'Discord', view: <DiscordView /> }]} />;
export const HubNetworkScreen = () => <HubSections tab="system" sections={[{ id: 'network', title: 'Network', view: <NetworkView /> }]} />;
export const HubBackupScreen = () => <HubSections tab="system" sections={[{ id: 'backup', title: 'Backup', view: <HubBackupView /> }]} />;
/** Search, as a hub answers "harbour" from the stock catalog (the music services are not recorded). */
export const HubSearchScreen = () => <HubSections tab="search" sections={[{ id: 'search', title: 'Search', view: <HubSearchView initialQuery="harbour" /> }]} />;
export const HubMusicSearchScreen = () => <HubSections tab="music" sections={[{ id: 'catalog', title: 'Music search', view: <MusicSearchSettingsView /> }]} />;
export const HubDiagnosticsScreen = () => <HubSections tab="system" sections={[{ id: 'diagnostics', title: 'Diagnostics', view: <DiagnosticsView /> }]} />;

/* ================================================================ companion */

/** The Settings tab as the companion's `App.tsx` lays it out: its sections, then the pane's foot. */
function CompanionSettingsTab({ children }: { children: (say: (text: string) => void) => ReactNode }) {
  const [note, setNote] = useState<string | null>(null);
  return (
    <Companion.ConfirmProvider>
      <CompanionWindow tab="settings" hubLine="No hub paired" dot="off" counts="0 folders · 0 playlists · 0 guides · 0 devices">
        {children(setNote)}
        <div className="panefoot">
          <p className="note" role="status">
            {note ?? 'Settings are kept on this PC.'}
          </p>
          <Companion.Push>Restore Defaults</Companion.Push>
        </div>
      </CompanionWindow>
    </Companion.ConfirmProvider>
  );
}

function Sect({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="sect" id={id} aria-label={title}>
      {children}
    </section>
  );
}

/** Settings ▸ Downloaders, General, Downloads and Network, as the companion draws them. */
function RealSettings({ say }: { say: (text: string) => void }) {
  const helper = useChannel('helper:status', undefined);
  const prefs = useChannel('app:preferences:get', undefined);
  return <SettingsView helper={helper} prefs={prefs} say={say} />;
}

function RealAbout({ say }: { say: (text: string) => void }) {
  const prefs = useChannel('app:preferences:get', undefined);
  return <AboutView prefs={prefs} say={say} />;
}

export const CompanionSettingsView = () => (
  <CompanionSettingsTab>
    {(say) => (
      <Sect id="settings" title="Settings">
        <RealSettings say={say} />
      </Sect>
    )}
  </CompanionSettingsTab>
);

export const CompanionBackupScreen = () => (
  <CompanionSettingsTab>
    {(say) => (
      <Sect id="backup" title="Backup">
        <CompanionBackupView say={say} />
      </Sect>
    )}
  </CompanionSettingsTab>
);

/** The Search tool, answering "harbour" from the stock catalog through the stand-in bridge. */
export const CompanionSearchScreen = () => (
  <CompanionWindow tab="search" hubLine="No hub paired" dot="off" counts="0 folders · 0 playlists · 0 guides · 0 devices">
    <Sect id="search" title="Search">
      <CompanionSearchView initialQuery="harbour" />
    </Sect>
  </CompanionWindow>
);

export const CompanionAboutScreen = () => (
  <CompanionSettingsTab>
    {(say) => (
      <Sect id="about" title="About">
        <RealAbout say={say} />
      </Sect>
    )}
  </CompanionSettingsTab>
);
