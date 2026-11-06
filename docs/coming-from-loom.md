# Coming from Loom

This page is for people who record with Loom today and want to try Rushes.
It maps what you do in Loom to where it lives in Rushes, and it is honest
about what Rushes does not do yet.

## The one big difference

Loom uploads every recording to Loom's cloud and gives you a link.
Rushes records to a folder on your Mac. Nothing leaves your Mac until you
choose to share. When you share, the video uploads to storage **you** own:
a Cloudflare Worker you deploy once, or an S3-compatible bucket.

That means two things:

- Recording, review, editing and export work with no account and no setup.
- A share link needs a one-time setup of your own storage. See
  [Self-host sharing](self-host-sharing.md). It takes about 15 minutes.
  Until you do it, "Copy video file" lets you paste the MP4 straight into
  Slack, email or a ticket.

## Feature map

| In Loom you… | In Rushes you… |
|---|---|
| Click the Loom icon in the menu bar | Click the Rushes icon in the menu bar. The small recorder opens. |
| Pick Screen + Cam, Screen only, or Cam only | Pick the same three modes at the top of the recorder. |
| Pick full screen, window or a custom size | Pick Full screen, Window or Area. Area lets you draw a frame. |
| Drag the camera bubble around | Drag the bubble. Its position is remembered. |
| Use the countdown | Choose 0, 3 or 5 seconds under More options. Esc cancels. |
| Pause and resume | Use the floating bar, or ⇧⌘P. |
| Start and stop with a shortcut | ⇧⌘R starts and stops. ⇧⌘Esc discards the take. |
| Restart a bad take | Use Restart on the floating bar. It asks before throwing the take away. |
| Draw on screen | Use Draw on the floating bar. Drawings are recorded into the video. |
| Hide the bubble mid-recording | Use × on the bubble. The camera track keeps recording. |
| Trim the start and end | Open Edit video, then the Trim tab. Split and undo work too. |
| Remove filler words and silences | Use Remove fillers and Remove silence in the editor. |
| Read and search the transcript | Transcripts are made on your Mac after you stop. Click a word to jump to it. Library search covers titles and transcript text. |
| Get an AI title, summary and chapters | Use Generate in the review window. It runs on your Mac. |
| Add captions | Burn them in, or export SRT and WebVTT files. Share pages show captions. |
| Copy a share link | Use Share in the review window after you set up sharing. The link is copied for you. |
| Password-protect or expire a link | Set a password and an expiry in the share panel (Worker mode). |
| Get comments and reactions | Viewers can comment and react on your Worker share page. You see them in Review. |
| See who watched | You get a view count and a desktop notification for new plays (Worker mode). Rushes does not show viewer names. |
| Download the video | Export MP4, MOV, a YouTube preset, a GIF, audio only, or the four original tracks. |
| Embed in Notion, a doc or a website | Use Copy embed code on a Worker share (see the share panel). |

## What Rushes gives you that Loom does not

- **Four separate original files.** Screen, camera, microphone and system
  audio are saved as separate files that start at the same instant. You can
  re-edit them in any editor, years later.
- **No upload limits and no recording length cap.** Your disk is the limit.
- **Crash safety.** If the app or the Mac dies mid-take, you lose at most
  one second. The take is recovered when you relaunch.
- **A command line and MCP server.** Every action is scriptable. AI agents
  can start, stop, export and share recordings.

## What Rushes does not do yet

Read this before you cancel Loom.

- **No notarized installer yet.** The preview build is not notarized by
  Apple, so macOS asks you to approve it once. See [Install](install.md).
- **No zero-setup sharing.** You set up your own storage once.
- **No viewer names, no team workspaces, no shared library.** Rushes is a
  single-person tool today.
- **No Chrome extension, no iOS app, no Windows app.**
- **No animated link unfurls.** GIF export works, and Worker share pages
  carry a short GIF preview, but Slack and email still unfurl a link with a
  still poster frame.
- **No folders or tags in the library.** Search covers titles and
  transcripts.
- **Loom import brings the video only.** Comments, reactions, view counts,
  Loom's transcripts, chapters and share links stay in Loom. Rushes makes
  its own transcript and captions on your Mac after the import.
- **No automatic updates yet.** Rushes tells you when a new version is out
  (Settings → Updates), but you download and install it by hand.

## Bring your Loom videos

1. In Loom, open a video and download it (Loom saves an MP4).
2. In Rushes, open the Library and click **Import video…**. Pick one or more
   `.mp4`, `.mov` or `.m4v` files, or drop them onto the Library.
3. Each video appears in the Library under its file name. Rushes then makes
   a transcript and captions on your Mac, so you can search what was said,
   trim, export and share it like any recording.

From the terminal: `rushes import ~/Downloads/my-loom-video.mp4`.

Rushes copies the file and never changes or moves your download. The video
is copied without re-encoding, so quality stays the same. Copy-protected
files cannot be imported.

## Your recordings

Recordings live in `~/Movies/Rushes`, one folder per take. You can back them
up, move them, or open the track files in any video editor. Deleting a take
in the app moves it to the Trash, so you can still recover it.

## Getting help

Open an issue on GitHub with what you did, what you expected and what
happened. `rushes verify <id>` checks one recording's files and is useful to
include.
