/** Cheap checks on raw PDF bytes, without loading a PDF library. */

const encoder = new TextEncoder();

export function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  const first = needle[0];
  let i = haystack.indexOf(first);
  while (i !== -1 && i <= haystack.length - needle.length) {
    let match = true;
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
    i = haystack.indexOf(first, i + 1);
  }
  return false;
}

export function isEncrypted(bytes: Uint8Array): boolean {
  return contains(bytes, encoder.encode('/Encrypt'));
}

/** Key on every annotation PDF Studio writes (and on its appearance stream). */
export const STUDIO_KEY = 'PDFStudio';

/** True if the file may hold PDF Studio annotations worth extracting. */
export function hasStudioMarker(bytes: Uint8Array): boolean {
  return contains(bytes, encoder.encode(`/${STUDIO_KEY}`));
}

/** True if the file contains digital signatures (or at least signature data). */
export function hasSignatures(bytes: Uint8Array): boolean {
  return contains(bytes, encoder.encode('/ByteRange')) && contains(bytes, encoder.encode('/Sig'));
}
