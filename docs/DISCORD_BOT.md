# The Discord bot

A bot that plays into a voice channel and shares one queue with everyone listening on the hub. It is
optional and off by default.

```sh
cd docker-container
./nowplaying install --discord      # or, later:
docker compose --profile discord up -d
```

It runs as its own container. A gateway outage, a rate-limit ban or a crash in the bot cannot take
the hub's API down with it; they share only the data directory.

## Setting it up

1. Create an application at <https://discord.com/developers/applications> and add a bot to it.
2. Copy the bot token into the hub's admin GUI, under **Discord**. Prefer this over the
   `NP_DISCORD_TOKEN` environment variable: in the GUI it is encrypted at rest with the installation
   key, rather than sitting in a compose file and in your shell history.
3. Invite the bot with the `bot` and `applications.commands` scopes, and the permissions the panel
   lists.
4. Optionally designate a channel and a DJ role. Both are checked before any command runs.

The Discord panel shows what is missing rather than failing silently — an absent token, an
un-granted intent, a designated channel the bot cannot see.

### Prefix commands need one extra step

Slash commands work as soon as the bot is invited. Prefix commands (`!play …`) additionally need the
**Message Content** intent, which Discord grants only after you enable it in the Developer Portal —
for verified bots, after review. The panel says so instead of leaving you wondering why `!play` is
ignored.

## The commands

|                             | What it does                                                                 |
| --------------------------- | ---------------------------------------------------------------------------- |
| `play <query or url>`       | Search and enqueue, or enqueue a pasted link                                 |
| `queue [page]`              | Show the queue, paged                                                        |
| `nowplaying`                | What is playing, with position                                               |
| `skip [reason]`             | Skip the current track; the reason is recorded in the history                |
| `pause` / `resume` / `stop` | Transport                                                                    |
| `shuffle`                   | Shuffle what is queued but not yet played                                    |
| `clear`                     | Empty the queue                                                              |
| `join` / `leave`            | Move the bot in and out of your voice channel                                |
| `settings`                  | The group's current policy: designated channel, DJ role, vote-skip threshold |

Every one exists as both a slash command and a prefix command.

## Why the two forms cannot drift

Both go through **one** `CommandService`. A slash interaction and a prefix message are parsed into
the same `MusicCommand`, authorized by the same `authorizeCommand`, applied to the same queue
reducer, and rendered from the same message templates. The Discord layer only decides how to reply.

That is not a convention — it is checked. `discord-parity.test.ts` runs every command through both
transports and asserts the outcomes are identical, including the refusals: a command refused because
you lack the DJ role must be refused the same way, with the same wording, whichever form you used.
The one legitimate difference is the transport field on the outcome.

## Who may do what

Discord users have no device pairing and no hub membership, so a Discord actor carries an
`authorizedRole` derived from the guild's own roles — DJ or administrator becomes `admin`, everyone
else `member`. Only the Discord adapter may set it, and a security test asserts that a paired device
cannot claim the same thing by putting it in a request body.

On top of that:

- **A designated channel**, when set, is the only place commands are accepted.
- **A DJ role**, when set, gates the commands that affect everyone: `skip`, `clear`, `stop`, `pause`.
- **Vote-skip** lets a room skip without a DJ, at a configurable threshold of the listeners present.

Refusals say what was needed, not just "no".

## What it plays

Only what the hub can legitimately stream: your own library, files a companion has transferred, and
providers whose terms allow a server-side stream. Where a provider offers playback only in a browser
(Spotify's Web Playback SDK) or only through an embed (YouTube), the bot cannot play it and says so
rather than joining the channel and going silent. See
[PROVIDER_CAPABILITIES.md](PROVIDER_CAPABILITIES.md) for the per-provider picture.

## The queue is shared

The bot is one participant in the hub's group queue, not a separate player. A track queued from
Discord appears in the player and in the admin GUI, in the same order, with the same revision number;
a track queued from a phone appears in `queue` in Discord. The queue is revision-checked, so two
people acting at once cannot silently overwrite each other — a stale command is rejected and says so.

History is recorded the same way from either side, including who requested each track and why it
ended. [architecture/GROUP_PLAYBACK.md](architecture/GROUP_PLAYBACK.md) describes the model.
