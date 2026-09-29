# Getting Started

Clash Desktop keeps projects and media on your Mac. Creating and editing a local
project does not require a Clash cloud account. Agents and generation providers
may require their own accounts.

The first release targets **macOS on Apple Silicon**. Public Beta acceptance is
still pending; use an installer only when its release notes identify the tested
candidate and any limitations. See [release status](./desktop-first-release.md).

## Install

1. Download the macOS **arm64** DMG supplied with the candidate's release notes.
2. Open the DMG, drag **Clash** into **Applications**, and eject the disk image.
3. Open Clash from Applications. You do not need Node, pnpm, or a source checkout
   for the packaged application.

A public installer must be signed and notarized. If macOS rejects it, record the
message and installer version and contact the person who supplied the candidate.
Unsigned invited previews have not passed the public-distribution gate.

## Set up an agent and generation

Open **Settings → Agents**, select an available agent, and complete the setup or
sign-in flow shown for that agent. An agent connection and a media generator are
separate capabilities.

Open **Settings → Plugins** to inspect installed generation plugins. For a
provider-backed model, configure its account in **Settings → Providers** and
select a model exposed by that provider. Use the actual models and settings
offered by your installed plugins; a missing generator cannot run from a button
alone. Provider availability, authentication, and charges follow that provider's
account. You can import your own media while configuring generation.

## Make a first video

1. Choose **New Project** and give the local project a name.
2. In **Assets**, choose **Upload from Mac** and import a short video or image.
   Confirm its preview opens before editing.
3. To generate media, open an installed generator's composer, enter a prompt,
   choose its supported settings, and select **Generate**. Wait for the pending
   output to become a playable or viewable Asset. Failures appear with that run.
4. Create a **Timeline** from the project sidebar. Use **Add media** to insert a
   Project Asset, then trim, move, or split the clip. Play the Timeline to check
   the cut and audio. Check **Timeline Properties → Duration (frames)**: the
   composition's saved duration controls both preview and export, including any
   empty tail after the last clip.
5. Open **Export → Export video**. Wait for the export to finish; an in-progress
   render is not an exported file. Open the completed output and save/download
   the video, then play the saved MP4 in QuickTime Player.
6. Quit and reopen Clash. Reopen the project and check its Assets and Timeline.

The first local export needs internet access to download Remotion's rendering
browser. Later exports reuse the local cache. If that download fails, restore
connectivity and retry; the project and imported media remain local.

In Storyboard, **Prompt** opens the existing generator settings in Preview;
**Regenerate** starts another run. **Reference** adds the selected Asset to the
chat draft and opens Chat. Review the draft and send it yourself. Selecting a
different candidate for preview does not replace the chosen material version.

## Upgrade manually

Finish or stop active work, quit Clash, and replace `/Applications/Clash.app` with
the new candidate from its DMG. Keep your Clash data and project folders. A normal
app replacement does not require deleting `~/.clash` or resetting settings.
Reopen the app and verify an existing project's media, Timeline, and provider
configuration. Keep a backup before trying a preview; downgrading a migrated
project is not promised. Automatic updates are outside the first-release scope.

## Troubleshooting

- **Startup fails:** use **Retry** in the startup error dialog. If it fails again,
  retain the diagnostic path shown in that dialog and the candidate version.
  macOS desktop logs are under `~/Library/Logs/Clash/`, including
  `host-startup.log`. Do not delete project storage to fix a launch failure.
- **Generation fails:** open the failed run, read its error, and check the
  selected plugin/provider account and required inputs. Retry only after fixing
  the cause; your previous completed Assets remain available.
- **Export fails or stays pending:** retain the error and project/Timeline names,
  confirm source media still previews, and include the desktop diagnostic logs
  when reporting the issue. Confirm a completed output before treating it as a
  successful export.
- **Report a problem:** include the app version, Mac architecture/macOS version,
  reproduction steps, error text, and a screenshot. Review logs before sharing;
  do not include provider credentials or private media without intending to.

## Developers and local agents

Source development requires Node 24.18+ within Node 24 and the repository's pnpm
version. From a prepared checkout, run `make install`, then `make dev-desktop`.
Follow the repository's pinned OpenMA common setup in `patches/README.md`.

The packaged Host is discovered automatically by the CLI. Link a working folder
once with `clash init --project <id>`; normal reads and writes do not need a status
preflight. `clash doctor` and `clash host status` are diagnostic commands.
