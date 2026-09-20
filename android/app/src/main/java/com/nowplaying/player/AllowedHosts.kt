package com.nowplaying.player

/**
 * The hosts a fetch may name.
 *
 * GENERATED FILE - do not edit. Written by `packages/contracts/scripts/emit-android-hosts.mjs`
 * from `HELPER_DEFAULT_HOSTS` in `packages/contracts/src/api/local-helper.ts`, which is the one
 * place this list lives. Change it there and run `pnpm generate`.
 *
 * This is not the gate that matters - the rights basis on every request is - but it stops a page
 * from pointing a subprocess at an arbitrary address, and it keeps the list of what this thing
 * touches short enough to read.
 */
object AllowedHosts {
  val hosts: List<String> = listOf(
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "soundcloud.com",
    "api.soundcloud.com",
    "on.soundcloud.com",
    "open.spotify.com",
    "bandcamp.com",
    "archive.org",
  )
}
