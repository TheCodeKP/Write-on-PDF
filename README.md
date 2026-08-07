<p align="center">
  <img src=".github/media/banner.png" alt="Write on PDF by CodeKP: type, sign and save PDFs in Chrome" width="820">
</p>

<p align="center">
  <b>Write, draw, sign, highlight, save and print PDFs directly in Chrome. Private, local and free.</b>
</p>

<p align="center">
  <a href="https://codekp.com/apps/write-on-pdf/">Try the live editor</a> ·
  <a href="https://codekp.com/apps/write-on-pdf/privacy.html">Privacy</a> ·
  <a href="https://github.com/TheCodeKP/Write-on-PDF/releases">Releases</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

A free Chrome extension that opens PDFs in its own editor so you can type on them, highlight, sign, then print or save. Your files stay on your machine. Nothing is uploaded, there is no account, and there is no analytics of any kind.

## What it looks like

<img src=".github/media/type-highlight-tick.png" alt="Filling an appointment form: typed answers, a yellow highlight, ticked boxes and a signature" width="100%">

<img src=".github/media/import-clean-sign.png" alt="Importing a photo of a signature, fading the paper away, then placing it on a contract" width="100%">

<img src=".github/media/keep-it-local.png" alt="A marked up proposal being saved and printed, with no uploads and no watermarks" width="100%">

## Install

**From the Chrome Web Store.** The listing is in review. When it is approved, a one-click install link lands here and on [codekp.com](https://codekp.com/apps/write-on-pdf/).

**From a release, today.**

1. Download the latest zip from [Releases](https://github.com/TheCodeKP/Write-on-PDF/releases/latest), or clone this repository.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder.
5. On the extension's card, turn on **Allow access to file URLs** if you want local PDFs and finished downloads to open in the editor too.

**Without installing anything.** The same editor runs on the [website](https://codekp.com/apps/write-on-pdf/), on the same code that ships here.

## Tools

Pick a tool from the second toolbar row; it stays active until you pick another.

Having a tool in hand does not lock you out of what is already on the page. A plain click picks up whatever is under it, so you can fix a word or recolour a shape without going back to Select first. Moving the hand still draws, which is what keeps a stroke over an earlier stroke a stroke rather than a drag.

| Tool | Key | What it does |
| --- | --- | --- |
| Select | `V` | Move and resize what is already there, and select page text. |
| Text | `T` | Click and type on one line. Font, size, bold, italic, underline, strikethrough, colour, highlight behind the text. |
| Text box | `W` | Drag out a width and type. The text wraps inside it and the box grows downwards as you fill it. |
| Pen | `P` | Draw freehand. Stamped as vectors, so it stays sharp at any zoom and can be moved or resized afterwards. |
| Highlighter | `H` | Drag a translucent band over text. Drag only, no click. Always stamped underneath your other notes. |
| Rectangle | `B` | Outline a region, with an optional fill. |
| Ellipse | `O` | Circle something, with an optional fill. |
| Line | `L` | A plain rule. |
| Arrow | `A` | Point at something. |
| Tick | `K` | A check mark. |
| Cross | `X` | An X mark. |
| Signature | `S` | Place a saved signature, drawn or imported from a photo. |
| Image | `I` | Drop in any picture, as its own tool rather than a corner of Signature. |

### Marking up text you have selected

With Select in hand, drag across words on the page as you would anywhere else. A small bar appears offering **Highlight**, **U** and **S**, which lay a highlight, an underline or a strikethrough over exactly the lines you picked out. Each one is an ordinary annotation afterwards: recolour it, move it, undo it.

### Signing

Press `S`. Draw a signature or use a PNG, JPEG or WebP image. **Remove the paper background** fades a photo of ink on paper so only the signature lands. Saved signatures stay available across documents.

## Also included

- Find across the document (`Ctrl+F`)
- Multi select for text notes, then align their edges or restyle them together
- Copy, cut and paste for annotations (`Ctrl+C` / `Ctrl+X` / `Ctrl+V`)
- Undo / redo (`Ctrl+Z` / `Ctrl+Shift+Z`)
- Zoom, fit to window, rotate
- Print (`Ctrl+P`) and save a copy (`Ctrl+S`)
- The full shortcut list at `?`
- Handlee, Indie Flower and Patrick Hand handwriting fonts, alongside Helvetica, Times and Courier
- Notes and reading position remembered per document

Notes are stamped as real text and vectors, not a screenshot of the page.

## Privacy

No server, no accounts, no analytics, no network calls at runtime. Your PDFs, signatures and preferences live in Chrome's own storage on your device. The full policy is in [PRIVACY.md](PRIVACY.md).

## Turning it off

Click the extension icon:

- **Open PDFs in the editor** is the master switch.
- **Include downloaded PDFs** controls whether finishing a PDF download opens the editor.
- **Open this tab's PDF in the editor** is the rescue button for anything that slipped through.

## Known limits

- Chrome's PDF setting should stay on **Open PDFs in Chrome**.
- Some restricted pages cannot run content scripts; use the popup rescue button.
- Stamped text uses Helvetica, Times, Courier or a handwriting face (Latin-1). Characters outside that set may show as `?`.
- Handwriting faces ship as a single weight, so Bold and Italic are unavailable while one is chosen.
- Password-protected PDFs ask for the password, then work as usual.

## Releases

Every version is tagged and released here, with notes written from [CHANGELOG.md](CHANGELOG.md).

- [1.1.0](https://github.com/TheCodeKP/Write-on-PDF/releases/tag/v1.1.0), 7 August 2026. Signatures, images, text boxes, handwriting, pen, shapes, find, multi select, copy and paste.
- [1.0.0](https://github.com/TheCodeKP/Write-on-PDF/releases/tag/v1.0.0), 6 August 2026. First public build, submitted to the Chrome Web Store.

## Feedback

Found a PDF it handles badly, or want a tool that is missing? Open an [issue](https://github.com/TheCodeKP/Write-on-PDF/issues) or write to <hi@codekp.com>.

## Licence

GPL-3.0. See [LICENSE](LICENSE).

PDF.js, pdf-lib and fontkit ship under `vendor/` with their own licences. The handwriting fonts are under the Open Font Licence; the licence travels with them in `vendor/fonts/OFL.txt`, and `tools/fetch-fonts.mjs` rebuilds the files from Google Fonts.
