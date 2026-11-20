# PDF Studio

An open-source, cross-platform PDF reader and editor: view, annotate, organize, fill forms, sign, edit and redact.

## Decisions

- **Platforms:** macOS, Windows, Linux (desktop)
- **License:** open source under **MIT**. Every dependency must use a permissive license (MIT, Apache-2.0, BSD). No GPL/AGPL code, so MuPDF is deliberately not used
- **Shell:** Tauri (Rust backend, web UI, MIT/Apache-2.0) for small installers and native file access
- **UI:** TypeScript + React
- **Rendering:** PDF.js (Apache-2.0) for pages, text layer, search and outline
- **Page operations, forms, stamping:** pdf-lib (MIT)
- **Text editing and true redaction:** PDFium (Apache-2.0/BSD) via WASM, added in the edit stage
- **Digital signatures:** PAdES certificate signatures (pyHanko sidecar or a Rust/JS signer, to be decided)
- **OCR:** Tesseract (Apache-2.0)

## Roadmap

1. **Viewer:** open files, tabs, zoom, thumbnails, search, outline/bookmarks, dark mode
2. **Annotate:** highlight, underline, comments, freehand, shapes, stamps
3. **Organize:** merge, split, reorder, rotate, delete pages, compress
4. **Forms:** fill AcroForms, create form fields
5. **Sign:** draw/type/image signatures, then certificate-based digital signatures and verification
6. **Edit:** edit text and images, true redaction
7. **Extras:** OCR, convert to/from images and Word, password protection, AI summarize / ask-the-PDF

## Known hard problems

- **Editing existing text:** PDFs store positioned glyphs, not paragraphs, and fonts are often subset. The approach is to remove the original text and lay out new text in a matching font, falling back to a similar font when glyphs are missing.
- **Trusted signatures:** Signatures appear "trusted" in other readers only when the certificate chains to a CA on their trust list.
- **XFA forms:** Legacy dynamic forms are out of scope for now.

## Status

**Stage 1 (viewer) is done:**

- Tabs for several open documents; open via the file picker, drag and drop, or the OS ("Open With", double-click once installed as the PDF handler)
- Continuous scrolling, with only the pages near the screen drawn so large files stay fast
- Zoom: fit width, fit page, presets, +/-, pinch or Ctrl/⌘ + scroll
- Rotate view, go to page, page thumbnails, outline (bookmarks)
- Selectable, copyable text
- Find with highlighted results, match case, next/previous
- Internal links and external links (opened in the browser)
- Password-protected PDFs
- Light, dark and system theme, plus night reading (dark pages)

### Shortcuts

| Action | macOS | Windows / Linux |
|---|---|---|
| Open | ⌘O | Ctrl+O |
| Close tab | ⌘W | Ctrl+W |
| Find | ⌘F | Ctrl+F |
| Zoom in / out | ⌘= / ⌘- | Ctrl+= / Ctrl+- |
| Actual size / fit width / fit page | ⌘0 / ⌘1 / ⌘2 | Ctrl+0 / Ctrl+1 / Ctrl+2 |
| Rotate view | ⌘R | Ctrl+R |
| Previous / next page | ← / → | ← / → |
| First / last page | Home / End | Home / End |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab | Ctrl+Tab / Ctrl+Shift+Tab |

## Development

Requires Node 20+ and Rust (for the desktop build).

```bash
npm install
npm run dev          # web UI only, at http://localhost:1420
npm run tauri dev    # desktop app
npm run tauri build  # installers
npm run sample       # regenerate public/samples/sample.pdf
```

In the web UI during development, `http://localhost:1420/?file=/samples/sample.pdf` opens the sample straight away.

### Project layout

- `src/lib/` — PDF loading (`pdf.ts`), search, desktop/browser bridge (`platform.ts`), view state
- `src/components/` — `Viewer` (scrolling and layout), `PageView` (one page: drawing, text, links, highlights), `Sidebar`, `Toolbar`, `SearchBar`
- `src-tauri/` — the desktop shell: file reading, native menu, "Open With" handling
