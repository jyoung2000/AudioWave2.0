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

What is _not_ cached is your audio. The player never copies your files; it reads them where they are,
through a directory handle you granted or a file you picked. That is why "Space used" in Settings
counts only the index and artwork thumbnails.

Updates use `registerType: 'prompt'`: when a new version is available you are told and asked, rather
than having the app swap itself out underneath a playing track.

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
  "orientation": "any", // a car dock may be either way up
  "start_url": "/",
  "categories": ["music", "entertainment"],
  "icons": [/* 192, 512, and a maskable 512 for Android launcher shapes */],
  "shortcuts": [/* Library, Now playing — long-press the icon */],
}
```

The maskable icon matters on Android: without one, the launcher crops the square icon into whatever
shape it uses and can cut the artwork. The maskable variant bleeds to the edges with the note inside
the safe zone.

An end-to-end test asserts the manifest is served, the icons resolve, and a service worker registers
— because "installable" is a claim that is easy to break and hard to notice.
