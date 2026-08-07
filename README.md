# Write on PDF

A free Chrome extension that opens PDFs in its own editor so you can type on them, highlight, sign, then print or save. Your files stay on your machine. Nothing is uploaded.

Homepage: https://codekp.com  
Privacy: https://codekp.com/apps/write-on-pdf/privacy.html

Chrome's built-in viewer is excellent for reading and light markup. When you need to type real text into a PDF and save those notes into the file, this extension takes a different path: it renders with [PDF.js](https://mozilla.github.io/pdf.js/) and writes with [pdf-lib](https://pdf-lib.js.org/).

## Install (developer / from source)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. On the extension's card, turn on **Allow access to file URLs** if you want local PDFs and finished downloads to open in the editor too.

When the Chrome Web Store listing is live, you can also install from there in one click.

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
| Rectangle | `B` | Outline a region. |
| Ellipse | `O` | Circle something. |
| Line | `L` | A plain rule. |
| Arrow | `A` | Point at something. |
| Tick | `K` | A check mark. |
| Cross | `X` | An X mark. |
| Signature | `S` | Place a saved signature or stamp image. |

### Marking up text you have selected

With Select in hand, drag across words on the page as you would anywhere else. A small bar appears offering **Highlight**, **U** and **S**, which lay a highlight, an underline or a strikethrough over exactly the lines you picked out. Each one is an ordinary annotation afterwards: recolour it, move it, undo it.

### Signing

Press `S`. Draw a signature or use a PNG, JPEG or WebP image. **Remove the paper background** fades a photo of ink on paper so only the signature lands. Saved signatures stay available across documents.

## Also included

- Find across the document (`Ctrl+F`)
- Undo / redo (`Ctrl+Z` / `Ctrl+Shift+Z`)
- Zoom, fit to window, rotate
- Print (`Ctrl+P`) and save a copy (`Ctrl+S`)
- The full shortcut list at `?`
- Handlee, Indie Flower and Patrick Hand handwriting fonts, alongside Helvetica, Times and Courier
- Notes and reading position remembered per document

Notes are stamped as real text and vectors, not a screenshot of the page.

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

## Licence

GPL-3.0. See [LICENSE](LICENSE).

PDF.js, pdf-lib and fontkit ship under `vendor/` with their own licences. The handwriting fonts are under the Open Font Licence; the licence travels with them in `vendor/fonts/OFL.txt`, and `tools/fetch-fonts.mjs` rebuilds the files from Google Fonts.
