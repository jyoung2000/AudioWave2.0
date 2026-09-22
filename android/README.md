# The Android app

The player, in a window this app owns, with yt-dlp inside it.

It is the same web application — not a port, not a fork. The web app already talks to "something that
can run the tools" through one interface (`music-player/src/lib/tools-core.ts`); a desktop helper is
one implementation of that over HTTP and this app is another over a JavaScript bridge. Nothing in the
player knows which it got. That is the only reason having an Android build does not mean maintaining
two products.

## What it adds over installing the PWA

**yt-dlp, on the phone.** That is the whole list, and it is worth being exact about why it is the
whole list: installing a PWA gives you an icon and a standalone window, not a different sandbox. A
page cannot start a program however it was launched. This app can, because it is a program.

## What it does not add

- **spotDL is not here.** It is a Python application with no Android build, and the half of it that
  reads Spotify needs an API key this app does not have. The app reports it as a named absence, not
  a button that fails. A helper on a computer can still run it.
- **Spotify's audio is still out of reach.** It is protected. No tool on any platform gets it, and
  this app does not pretend otherwise. The player says the same thing it says everywhere else.
- **Background playback is *worse* here, not better.** In a browser, the browser is the foreground
  app and Media Session keeps audio alive; in a WebView inside this app, Android may suspend it when
  you switch away. Fixing that properly needs a playback foreground service driven by the page,
  which is not in this version. If listening with the screen off is what matters most to you today,
  use the browser.
- **Google Play will not carry it.** Apps that fetch audio from YouTube get removed. This is a
  sideload or an F-Droid build, which also means no automatic updates from a store.

## How it is put together

| | |
| --- | --- |
| `MainActivity.kt` | A WebView serving the player over **https** from `appassets.androidplatform.net` via `WebViewAssetLoader`. Not `file://` — that is not a secure context, and without one there is no service worker, no IndexedDB, no origin-private file system and no audio worklet. One class, and it buys the whole application. |
| `ToolsBridge.kt` | The `@JavascriptInterface`. Strings in, strings out, synchronously, in the shapes from `packages/contracts`. Nothing may wait: a fetch starts a job and returns it, and progress arrives by polling, as it does over HTTP. |
| `Jobs.kt` | Builds the command line and runs it. Every flag is written here; the page names a URL, a tool and a format and can name no flag. `--ignore-config` is first, because a config file in the app's own directory could otherwise add `--exec`. |
| `Tools.kt` | Unpacks yt-dlp on first run, reports what it actually knows meanwhile, and holds the host allowlist — the same list the desktop helper uses, because two implementations of one promise should not quietly differ. |
| `FetchService.kt` | A foreground service so a download survives you switching away. |
| `awsp/` | **Stream from a PC**: the native AWSP client (iroh + Media3), a second launcher entry with its own `mediaPlayback` foreground service, so it keeps playing with the screen off. Separate from the WebView player. See [AWSP-ANDROID.md](AWSP-ANDROID.md). |

The bridge is reachable from any page loaded in the WebView, so the WebView loads exactly one page
and hands every other link to the real browser. That refusal in `shouldOverrideUrlLoading` is the
boundary everything else assumes; as a second wall, every bridge method refuses to answer when the
top-level page is not the app's own. (Moving the bridge to `WebViewCompat.addWebMessageListener`,
which the WebView restricts by origin and frame, would be stronger, but it is asynchronous and needs
the player's `android-bridge.ts` to change with it.)

Also in `MainActivity.kt`: `<input type="file">` opens the system document picker; `blob:` downloads
(exports) are caught by a script injected only into the app's origin and saved through the system's
"save as" dialog (`BlobDownloads.kt`); a crashed WebView renderer is replaced rather than taking the
app down; and Back moves the app to the background instead of closing the player. The WebView never
loads `http` from the `https` page, so a hub on the local network must be reached over https.

## The gate

Every fetch carries a rights basis — it is mine, the creator offers it, public domain, licensed to
me, I bought it — and is refused without one. Per fetch, not once: a one-time "I have the rights"
box is a worse gate, because everyone ticks it once and then stops thinking about it.

Bundling the tool is a real change of posture and worth naming. Until now someone had to go and
install yt-dlp themselves, which was itself a decision; here it arrives with the app. The per-fetch
basis is what stands in for that decision, and the host allowlist is what stops the app being a
general-purpose downloader. Running yt-dlp against YouTube is still against YouTube's terms, and
that is still between you and them. See `docs/DOWNLOADS_AND_LEGAL.md`.

## Building it

The player is copied in as built output, so build that first. It must be built for the path the app
serves it from, `/assets/app/`; with the default base of `/` the page asks for `/assets/index-*.js`,
which is not where the file is, and the app opens to a blank screen.

```
NP_BASE_PATH=/assets/app/ pnpm build:player
rm -rf android/app/src/main/assets/app
cp -R music-player/dist android/app/src/main/assets/app

cd android
./gradlew assembleDebug
```

In PowerShell, set the variable with `$env:NP_BASE_PATH = '/assets/app/'` before `pnpm build:player`.

APKs land in `app/build/outputs/apk/debug/`, one per architecture — `arm64-v8a` is the one almost
every phone since about 2017 wants. They are split because the tool libraries carry a Python runtime
and an FFmpeg build for each ABI, and a universal APK would be mostly code for a processor you do
not have.

A release build needs a keystore, which this repository does not contain and should not.

## What has and has not been verified

`.github/workflows/android.yml` builds this on every push. That workflow is where the code is
compiled for the first time: the container this was written in cannot reach Google's Maven or the
Android SDK, so none of the Kotlin here was compiled before it was committed.

What *was* verified before committing: the library's coordinates and its API, read out of the actual
artifacts on Maven Central rather than recalled — `com.yausername.youtubedl_android.YoutubeDL`,
`YoutubeDLRequest.addOption`, `execute(request, id, callback)`, `destroyProcessById`, and
`com.yausername.ffmpeg.FFmpeg` — plus every XML file parsing. The web half is covered by
`music-player/tests/dom/tool-backend.test.ts`, which drives a fake of this bridge through the same
assertions as the HTTP transport.

Nobody has run it on a phone. Until someone has, treat the first build as a first build.
