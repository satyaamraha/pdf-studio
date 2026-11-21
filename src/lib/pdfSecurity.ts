import { PDFDocument } from 'pdf-lib';
import { collectGarbage } from './pdfPages';
import { getPdfium, Mem, type Pdfium } from './pdfium';

/**
 * Password protection (AES-256) using PDFium. Encrypted files are decrypted when opened
 * so every feature works on them, and protected again when saved.
 */

export interface Permissions {
  print: boolean;
  /** Full-quality printing (otherwise only low-resolution). */
  printHigh: boolean;
  modify: boolean;
  copy: boolean;
  annotate: boolean;
  fillForms: boolean;
  /** Insert, delete and rotate pages. */
  assemble: boolean;
}

export interface Security {
  /** Password needed to open. '' = opens without one; null = not known (ask before saving). */
  openPassword: string | null;
  /** Password for changing protection and permissions. null = not known. */
  ownerPassword: string | null;
  permissions: Permissions;
}

export const ALL_ALLOWED: Permissions = { print: true, printHigh: true, modify: true, copy: true, annotate: true, fillForms: true, assemble: true };

// Permission bits (PDF "P" entry), 1-based bit numbers.
const BIT = { print: 3, modify: 4, copy: 5, annotate: 6, fillForms: 9, accessibility: 10, assemble: 11, printHigh: 12 };

export function permissionsFromBits(p: number): Permissions {
  const on = (bit: number) => (p & (1 << (bit - 1))) !== 0;
  return {
    print: on(BIT.print),
    printHigh: on(BIT.printHigh),
    modify: on(BIT.modify),
    copy: on(BIT.copy),
    annotate: on(BIT.annotate),
    fillForms: on(BIT.fillForms),
    assemble: on(BIT.assemble),
  };
}

export function permissionsToBits(p: Permissions): number {
  let bits = 0xfffff0c0; // reserved bits that must be 1
  const set = (bit: number, v: boolean) => {
    if (v) bits |= 1 << (bit - 1);
  };
  set(BIT.print, p.print);
  set(BIT.printHigh, p.print && p.printHigh);
  set(BIT.modify, p.modify);
  set(BIT.copy, p.copy);
  set(BIT.annotate, p.annotate);
  set(BIT.fillForms, p.fillForms || p.annotate);
  set(BIT.accessibility, true); // always allow screen readers
  set(BIT.assemble, p.assemble);
  return bits | 0;
}

export const isRestricted = (p: Permissions) => Object.values(p).some((v) => !v);

export class PasswordNeeded extends Error {
  constructor() {
    super('This document needs a password.');
  }
}

function open(m: Pdfium, mem: Mem, bytes: Uint8Array, password: string): number {
  const p = mem.bytes(bytes);
  return m.FPDF_LoadMemDocument(p, bytes.length, password);
}

function save(m: Pdfium, mem: Mem, doc: number): Uint8Array {
  const w = m.PDFiumExt_OpenFileWriter();
  try {
    if (!m.PDFiumExt_SaveAsCopy(doc, w)) throw new Error("Couldn't save the document.");
    const n = m.PDFiumExt_GetFileWriterSize(w);
    const p = mem.alloc(n);
    m.PDFiumExt_GetFileWriterData(w, p, n);
    return mem.read(p, n);
  } finally {
    m.PDFiumExt_CloseFileWriter(w);
  }
}

/** Drops the encryption leftovers PDFium keeps in a full save. */
async function tidy(bytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  collectGarbage(pdf);
  return pdf.save({ useObjectStreams: true, updateFieldAppearances: false });
}

export interface Decrypted {
  bytes: Uint8Array;
  security: Security;
  /** Opened with the owner password (or the file has no owner restrictions to unlock). */
  owner: boolean;
}

/**
 * Decrypts an encrypted PDF. Throws PasswordNeeded if `password` doesn't open it.
 * `original` is kept by the caller to unlock owner rights later.
 */
export async function decryptPdf(bytes: Uint8Array, password: string): Promise<Decrypted> {
  const m = await getPdfium();
  const mem = new Mem(m);
  try {
    const doc = open(m, mem, bytes, password);
    if (!doc) {
      if (m.FPDF_GetLastError() === 4) throw new PasswordNeeded();
      throw new Error(`This file couldn't be opened (error ${m.FPDF_GetLastError()}).`);
    }
    try {
      const owner = m.EPDF_IsOwnerUnlocked(doc);
      // The permissions everyone gets (what the author allowed without the owner password).
      const permissions = permissionsFromBits(m.FPDF_GetDocUserPermissions(doc) >>> 0);
      // A non-empty password that unlocks owner rights is the owner password; then the open
      // password is only known if the file opens without one. Otherwise it was the open password.
      const usedOwner = owner && password !== '';
      const security: Security = {
        openPassword: usedOwner ? (openWithEmpty(m, mem, bytes) ? '' : null) : password,
        ownerPassword: usedOwner ? password : null,
        permissions,
      };
      if (!m.EPDF_RemoveEncryption(doc)) throw new Error("Couldn't remove the protection to edit this file.");
      return { bytes: await tidy(save(m, mem, doc)), security, owner };
    } finally {
      m.FPDF_CloseDocument(doc);
    }
  } finally {
    mem.free();
  }
}

function openWithEmpty(m: Pdfium, mem: Mem, bytes: Uint8Array): boolean {
  const d = open(m, mem, bytes, '');
  if (d) m.FPDF_CloseDocument(d);
  return !!d;
}

/** Checks an owner password against the original encrypted file. */
export async function checkOwnerPassword(original: Uint8Array, password: string): Promise<boolean> {
  const m = await getPdfium();
  const mem = new Mem(m);
  try {
    const doc = open(m, mem, original, password);
    if (!doc) return false;
    const owner = m.EPDF_IsOwnerUnlocked(doc);
    m.FPDF_CloseDocument(doc);
    return owner;
  } finally {
    mem.free();
  }
}

/** Protects a PDF with AES-256. Either password may be empty (but not both meaningfully). */
export async function encryptPdf(bytes: Uint8Array, security: Security): Promise<Uint8Array> {
  const openPassword = security.openPassword ?? '';
  // Without a separate owner password, the open password also controls permissions.
  const ownerPassword = security.ownerPassword || openPassword || randomPassword();
  const m = await getPdfium();
  const mem = new Mem(m);
  try {
    const doc = open(m, mem, bytes, '');
    if (!doc) throw new Error(`Couldn't prepare the document for protection (error ${m.FPDF_GetLastError()}).`);
    try {
      if (!m.EPDF_SetEncryption(doc, openPassword, ownerPassword, permissionsToBits(security.permissions))) {
        throw new Error("Couldn't add password protection.");
      }
      return save(m, mem, doc);
    } finally {
      m.FPDF_CloseDocument(doc);
    }
  } finally {
    mem.free();
  }
}

function randomPassword(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
