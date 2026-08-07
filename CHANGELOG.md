# Changelog

All notable changes to Write on PDF. Versions follow the manifest.

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
