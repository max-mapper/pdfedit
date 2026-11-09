// The stream layer (openForEdit) on any file PDFium opens without a password.
//
// openForEdit reads the file with pdf-lib, which cannot decrypt, so it refuses a file whose trailer has /Encrypt. A file
// encrypted with an owner password only opens with the empty user password (its permissions may restrict printing,
// copying or changing it); openEditable reads such a file from PDFium's decrypted copy (Pdfium.decryptCopy): the same
// pages, objects and content streams, unencrypted. Every reader of a file's objects goes through it, so the objects it
// lists are the ones exportDoc edits (exportDoc edits the same decrypted copy and writes the output unencrypted).
// A file that needs a user password throws PDFium's PdfiumOpenError with `needsPassword` (there is no way to give one).
import type { Pdfium } from '../engine/pdfium.ts';
import { openForEdit, type PdfEdit } from './edit.ts';
import { readTail } from './incremental.ts';

/** True when the last trailer has /Encrypt (false when the trailer cannot be read: openForEdit reports that). */
export function hasEncrypt(bytes: Uint8Array): boolean {
  try { return readTail(bytes).encrypted; } catch { return false; }
}

/** The file opened for content-stream editing; an encrypted file (owner password only) as PDFium's decrypted copy.
 *  `decrypted`: the copy was used. */
export async function openEditable(bytes: Uint8Array, P: Pdfium): Promise<{ edit: PdfEdit; decrypted: boolean }> {
  if (!hasEncrypt(bytes)) return { edit: await openForEdit(bytes), decrypted: false };
  const copy = P.decryptCopy(bytes); // throws PdfiumOpenError (needsPassword) when a user password is required
  if (!copy) return { edit: await openForEdit(bytes), decrypted: false }; // PDFium finds no encryption: openForEdit decides
  return { edit: await openForEdit(copy), decrypted: true };
}
