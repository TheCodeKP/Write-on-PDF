# Changelog

All notable changes to Write on PDF. Versions follow the manifest.

## 1.2.0

Password-protected PDFs and a single shared source for Chrome, Edge and Firefox
builds.

### Added

- Open, annotate, Save and Print for password-protected PDFs. Export decrypts
  the file first, then stamps your notes. The first Save shows a one-time
  warning that the download is no longer password protected.
- Per-browser manifests and a build step that assembles Chrome, Edge and
  Firefox bundles from the same source. The product name stays Write on PDF on
  every browser; the browser name appears only in the build folder name.
- Firefox support: Manifest V3 with a gecko id, background scripts, and PDF
  open handoff that works with Firefox's download and navigation model.

## 1.1.0

Builds a full annotation toolkit on top of the 1.0 typing and highlighting.

### Added

- Signature tool. Draw one or upload an image with the paper background knocked
  out, then keep it in a strip for reuse.
- Images, placed where you click, aspect ratio locked by default, with an option
  to save them alongside signatures.
- Text boxes that wrap as you type, with left, centre and right paragraph
  alignment and an optional background fill.
- Handwriting faces (Handlee, Indie Flower and Patrick Hand) embedded and subset
  into the saved file through fontkit.
- Multi select for text notes by marquee, Shift click or Ctrl+A, then align
  their edges or restyle them together.
- Find in document, with match highlighting and a case sensitivity toggle.
- Freehand pen, shapes, arrows, and tick and cross marks.
- A keyboard shortcut reference.
- Tab inside a text box inserts an indent instead of moving focus out of the
  box. Saved files render it as four spaces.
- Copy, cut and paste for selected annotations (Ctrl+C / Ctrl+X / Ctrl+V),
  including text notes, shapes, lines, ink, marks and images.
- Clicking a text note selects it; double-click to type. A new note still
  opens ready to type.
- Rectangle, ellipse, line and arrow only appear when dragged out. A plain
  click no longer drops a default-sized shape.
- Image is its own toolbar tool (I), separate from Signature. Signature keeps
  draw, upload and paper-background removal; Image places a photo as-is.
- Highlighter tip points to the Select-words path (highlight, underline, strike).
- Thickness on a selected underline or strike changes the line weight.
- Highlight opacity is adjustable. Rectangles and ellipses can take a fill
  colour as well as a stroke.

### Changed

- Ctrl+Z now drives the annotation history even while the caret sits inside a
  text box.

### Fixed

- PDFs opened by a page's own Print button now land in the editor. These are
  blob URLs, and Chrome does not fire navigation events for them reliably, so
  the editor was being skipped and the built in Chrome viewer opened instead.
  Once the bytes are captured the extension now finds the tab showing that blob
  and redirects it, with a short poll for tabs that appear a moment later.

## 1.0.0

First public release, submitted to the Chrome Web Store on 6 August 2026.

### Added

- Typing and highlighting on any PDF, opened in the extension's own editor
  rather than the built in Chrome viewer.
- Print or save the annotated file.

---

Everything runs locally in every release. No network calls, no analytics, no
accounts.
