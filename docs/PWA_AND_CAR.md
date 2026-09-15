# Installing, offline, and using it in a car

## Installing

The player is a Progressive Web App. In any browser's menu, "Install" or "Add to home screen" gives
it an icon, its own window with no browser chrome, and a place in the app switcher. There is no store
listing and no account.

Installed or not, it is the same app with the same data — installing changes the frame, not the
capabilities.

## Working offline

The player is built offline-first, which here means something specific: **it never needed the network
in the first place.** Your music is read from your own device. There is no server to be offline
_from_ unless you have paired a hub.

The service worker precaches the application itself — about 1.5 MB across 31 files — so the app
starts with no network at all. Your library index, playlists, equalizer presets and listening history
live in IndexedDB on the device.

Your audio is handled two ways. A folder you connect is read where it is, through the directory
handle you granted, and never copied. Files you _choose_ are different: a picker hands the app a file
it cannot reopen later, so the player can keep its own copy in the browser's private storage for this
app — never uploaded, never visible to other sites, removed when you remove the files. That is on by
default wherever folders cannot be connected (every phone, and Firefox and Safari on the desktop),
and a checkbox under Settings → Music folders elsewhere. "Space used" in Settings counts the copies
alongside the index and artwork thumbnails, and says whether the browser has promised not to clear
them under storage pressure.

Updates are a prompt, not a swap: the service worker downloads a new version in the background and
the player shows a notice with a Reload button, rather than replacing itself underneath a playing
track. (Until this was tested, the worker was built but never registered — the offline claims above
were true of the design and false of the app. An end-to-end test now reloads the page with the
network switched off.)

## On a phone

There is nothing to set up and no key to obtain: the player is a web page, so a phone needs an
address to open. Open it, add it to the home screen, choose some music.

| | Android | iPhone and iPad |
| --- | --- | --- |
| Install | Chrome's menu → **Install app** (or **Add to Home screen**) | Safari's share sheet → **Add to Home Screen** |
| Adding music | **Choose files** — the folder picker does not exist on phones; copies are kept in the app | The same |
| Offline | The app shell, the index and the copies are all on the phone | The same |
| Lock screen and headset | Media Session: title, art, play, pause, next, previous, seek | The same, with one caveat below |
| Volume | The app's slider, or the buttons | The buttons only: iOS fixes the media volume, and Settings says so |

The caveat: processed audio (the equalizer path, which is also the crossfade path) keeps running
when an iPhone locks its screen only where the Audio Session API exists, which is iOS 17 and later.
The player declares its session as playback there. On older versions audio can stop when the screen
locks; Settings → Car, lock screen and headset reports which case you are in, from the browser
rather than from a guess. A call, Siri or another app taking the audio output away is recovered from
when you come back to the player.

A phone browser evicts a site's storage after a while if the site is not used, and iOS is strict about
it for pages that are not on the home screen. Installing the app is what makes the copies durable; the
Storage panel shows whether the browser has granted persistence.

### Getting it an address

The repository carries a workflow (`.github/workflows/pages.yml`) that publishes the player to GitHub
Pages on every push to `main`. Enable it once under the repository's Settings → Pages by choosing
**GitHub Actions** as the source, and the player is at `https://<owner>.github.io/<repository>/`,
installable from any phone, with no server of your own. The same build works from any static host;
set `NP_BASE_PATH` to the path it is served from.

### What breaks offline

|  |  |
| --- | --- |
| Playing your own files | Works |
| Library, playlists, equalizer, metrics, constellation | Work |
| Search across providers | Needs the hub, which needs the network |
| Shared listening | Needs the hub |
| Sending a file to a hub | Needs the hub |

Each of these says so on screen when it cannot work, rather than failing silently.

## In a car

### What works

Once audio is playing on the phone, the **Media Session API** publishes the current track and accepts
controls. Android Auto, CarPlay and plain Bluetooth head units all read it. That gets you:

- Title, artist, album and artwork on the car's display.
- Play, pause, next and previous from the steering wheel, the car's screen, and headset buttons.
- Seeking from the car display, where the browser implements it.
- Voice assistant transport commands, through the same handlers.

Settings → **Playing in a car** shows each of these with a yes or a no _for the browser you are
actually using_ — it is computed by asking the browser, not assumed — with the reason beside it.

### What does not work, and will not

**The player cannot appear as an icon on the Android Auto or CarPlay home screen.** Those launchers
list only native apps built against the car app libraries (Android's `androidx.car.app`, Apple's
CarPlay entitlements) and distributed through the app stores. This is a platform restriction on the
launcher, not a gap in this implementation: no web app of any kind can appear there, and no amount of
manifest configuration changes it.

If you need a tile, you need a native app — a different piece of software, requiring a developer
account, a platform review, and for CarPlay an entitlement Apple grants only to certain categories.

### The three steps

1. **Install the player** from your browser's menu, so it opens without browser chrome and stays put
   in the app switcher.
2. **Start playback on the phone**, before or after connecting.
3. **Connect by Bluetooth or USB.** The car shows the track and its controls work.

This is the same path any audio app that is not in the car's launcher takes, including plenty of
native ones. What you lose against a tile is starting playback _from_ the car's screen; everything
after that is the same.

### Practical notes

- Publish artwork before you set off: it is passed as a blob URL the app already owns, so the car
  display never causes a network request.
- Some head units only show metadata for the _active_ audio focus owner. If another app grabs focus,
  pause and resume the player.
- Battery: the screen is the expensive part. In a standalone install with the screen off, the player
  is an audio element and a service worker.

## The manifest

```jsonc
{
  "name": "Now Playing",
  "display": "standalone", // its own window, no browser chrome
  "display_override": ["standalone", "minimal-ui"],
  "launch_handler": { "client_mode": "focus-existing" }, // a second tap focuses the one that is playing
  "orientation": "any", // a car dock may be either way up
  "id": "/", "start_url": "/", "scope": "/", // all three follow NP_BASE_PATH on a project page
  "categories": ["music", "entertainment"],
  "icons": [/* 192, 512, and a maskable 512 for Android launcher shapes */],
  "shortcuts": [/* Library, Now playing — long-press the icon */],
}
```

The maskable icon matters on Android: without one, the launcher crops the square icon into whatever
shape it uses and can cut the artwork. The maskable variant bleeds to the edges with the note inside
the safe zone.

iPhones read a 180-pixel `apple-touch-icon` and the `apple-mobile-web-app-*` metas rather than the
manifest's icons, so the page carries both. The viewport is `viewport-fit=cover`, and the bar and the
body pad themselves by the safe-area insets so nothing sits under a notch or the home indicator.

An end-to-end test asserts the manifest is served, the icons resolve, a service worker registers, and
the page reloads with the network off — because "installable" and "offline" are claims that are
easy to break and hard to notice.
