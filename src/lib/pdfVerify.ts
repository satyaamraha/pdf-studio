import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFSignature, PDFString } from 'pdf-lib';
import { binaryToBytes, bytesToBinary, parseCms, verifyRsa } from './cms';

export type SignatureStatus =
  /** Signature checks out and nothing was added afterwards. */
  | 'valid'
  /** Signature checks out, but more was added to the file later (e.g. another signature). */
  | 'valid-later-changes'
  /** The signed content was altered, or the signature doesn't match. */
  | 'invalid'
  /** A kind of signature this app can't check yet (e.g. non-RSA keys). */
  | 'unknown';

export interface SignatureInfo {
  field: string;
  signer: string;
  email: string;
  issuer: string;
  selfSigned: boolean;
  signedAt: string | null;
  reason: string;
  location: string;
  status: SignatureStatus;
  /** Plain-language explanation of the status. */
  detail: string;
}

const text = (v: unknown) => (v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '');

function parseDate(s: string): string | null {
  const m = s.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/);
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', z, oh = '00', om = '00'] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${se}${!z || z === 'Z' ? 'Z' : `${z}${oh}:${om}`}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const SUBTLE: Record<string, string> = { 'SHA-1': 'SHA-1', 'SHA-256': 'SHA-256', 'SHA-384': 'SHA-384', 'SHA-512': 'SHA-512' };

/** Checks every digital signature in a PDF. */
export async function verifySignatures(bytes: Uint8Array): Promise<SignatureInfo[]> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const out: SignatureInfo[] = [];
  for (const field of pdf.getForm().getFields()) {
    if (!(field instanceof PDFSignature)) continue;
    const v = field.acroField.dict.lookup(PDFName.of('V'));
    if (!(v instanceof PDFDict)) continue; // an empty "sign here" field
    const info: SignatureInfo = {
      field: field.getName(),
      signer: text(v.lookup(PDFName.of('Name'))) || 'Unknown signer',
      email: '',
      issuer: '',
      selfSigned: false,
      signedAt: parseDate(text(v.lookup(PDFName.of('M')))),
      reason: text(v.lookup(PDFName.of('Reason'))),
      location: text(v.lookup(PDFName.of('Location'))),
      status: 'unknown',
      detail: '',
    };
    out.push(info);
    try {
      const subFilter = (v.lookup(PDFName.of('SubFilter')) as PDFName | undefined)?.decodeText() ?? '';
      if (!/adbe\.pkcs7\.detached|ETSI\.CAdES\.detached/.test(subFilter)) {
        info.detail = `This kind of signature (${subFilter || 'unknown'}) can't be checked here yet.`;
        continue;
      }
      const br = v.lookup(PDFName.of('ByteRange'), PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
      const contents = v.lookup(PDFName.of('Contents'));
      if (br.length !== 4 || !(contents instanceof PDFHexString || contents instanceof PDFString)) throw new Error('Malformed signature.');
      const cmsBytes = contents instanceof PDFHexString ? hexToBytes(contents.asString()) : binaryToBytes(contents.asString());
      const cms = parseCms(cmsBytes);
      const cert = cms.signer;
      if (cert) {
        info.signer = String(cert.subject.getField('CN')?.value ?? info.signer);
        info.email = String(cert.subject.getField('E')?.value ?? '');
        info.issuer = String(cert.issuer.getField('CN')?.value ?? cert.issuer.getField('O')?.value ?? '');
        info.selfSigned = cert.isIssuer(cert);
      }
      if (!info.signedAt && cms.signingTime) info.signedAt = cms.signingTime.toISOString();
      if (!cert || !cms.digestAlgorithm) {
        info.detail = 'The signing certificate uses a key type this app can’t check yet.';
        continue;
      }

      const signedBytes = new Uint8Array(br[1] + br[3]);
      signedBytes.set(bytes.subarray(br[0], br[0] + br[1]), 0);
      signedBytes.set(bytes.subarray(br[2], br[2] + br[3]), br[1]);
      const digest = new Uint8Array(await crypto.subtle.digest(SUBTLE[cms.digestAlgorithm], signedBytes));

      let ok: boolean;
      if (cms.signedAttrsDer) {
        const md = cms.messageDigest;
        const sameDigest = !!md && md.length === digest.length && md.every((b, i) => b === digest[i]);
        if (!sameDigest) {
          info.status = 'invalid';
          info.detail = 'The document was changed after it was signed.';
          continue;
        }
        ok = verifyRsa(cert, cms.digestAlgorithm, cms.signedAttrsDer, cms.signature);
      } else {
        ok = verifyRsa(cert, cms.digestAlgorithm, bytesToBinary(signedBytes), cms.signature);
      }
      if (!ok) {
        info.status = 'invalid';
        info.detail = "The signature doesn't match the signer's certificate.";
        continue;
      }
      const coversAll = br[2] + br[3] === bytes.length;
      info.status = coversAll ? 'valid' : 'valid-later-changes';
      info.detail = coversAll
        ? 'The document hasn’t changed since it was signed.'
        : 'The signed version is intact; more was added to the file afterwards (for example another signature).';
    } catch (err) {
      info.status = 'unknown';
      info.detail = `Couldn't check this signature: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
