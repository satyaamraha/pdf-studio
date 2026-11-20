import forge from 'node-forge';

/**
 * CMS (PKCS#7) SignedData for PDF signatures, built by hand with node-forge's ASN.1
 * tools so it follows PAdES baseline: detached content, SHA-256, and the
 * signing-certificate-v2 attribute that binds the signer's certificate.
 */
const { asn1, pki } = forge;
const T = asn1.Type;
const C = asn1.Class;

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
};

const seq = (items: forge.asn1.Asn1[]) => asn1.create(C.UNIVERSAL, T.SEQUENCE, true, items);
const set = (items: forge.asn1.Asn1[]) => asn1.create(C.UNIVERSAL, T.SET, true, items);
const oid = (o: string) => asn1.create(C.UNIVERSAL, T.OID, false, asn1.oidToDer(o).getBytes());
const octets = (bytes: string) => asn1.create(C.UNIVERSAL, T.OCTETSTRING, false, bytes);
const int = (n: number) => asn1.create(C.UNIVERSAL, T.INTEGER, false, asn1.integerToDer(n).getBytes());
const nul = () => asn1.create(C.UNIVERSAL, T.NULL, false, '');
const algo = (o: string) => seq([oid(o), nul()]);
const der = (node: forge.asn1.Asn1) => asn1.toDer(node).getBytes();

export function bytesToBinary(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

export function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Issuer name and serial number exactly as encoded in the certificate. */
function issuerAndSerial(cert: forge.pki.Certificate): { issuer: forge.asn1.Asn1; serial: forge.asn1.Asn1 } {
  const tbs = (pki.certificateToAsn1(cert).value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[];
  // tbsCertificate: [0] version (optional), serial, signature algorithm, issuer, …
  const i = tbs[0].tagClass === C.CONTEXT_SPECIFIC ? 1 : 0;
  return { serial: tbs[i], issuer: tbs[i + 2] };
}

/**
 * Signs a SHA-256 digest of the document (the bytes outside /Contents) and returns
 * the DER-encoded CMS ContentInfo to put in the signature dictionary.
 */
export function buildCms(digest: Uint8Array, key: forge.pki.rsa.PrivateKey, chain: forge.pki.Certificate[]): Uint8Array {
  const signer = chain[0];
  const certDer = der(pki.certificateToAsn1(signer));
  const certHash = forge.md.sha256.create().update(certDer).digest().getBytes();
  const { issuer, serial } = issuerAndSerial(signer);

  const attribute = (type: string, value: forge.asn1.Asn1) => seq([oid(type), set([value])]);
  const attrs = [
    attribute(OID.contentType, oid(OID.data)),
    attribute(OID.messageDigest, octets(bytesToBinary(digest))),
    // ESSCertIDv2 { certHash (SHA-256 is the default algorithm), issuerSerial { [4] issuer name, serial } }
    attribute(
      OID.signingCertificateV2,
      seq([seq([seq([octets(certHash), seq([seq([asn1.create(C.CONTEXT_SPECIFIC, 4, true, [issuer])]), serial])])])]),
    ),
  ];
  // DER requires a SET's members in order of their encodings.
  attrs.sort((a, b) => (der(a) < der(b) ? -1 : der(a) > der(b) ? 1 : 0));

  const md = forge.md.sha256.create();
  md.update(der(set(attrs)));
  const signature = key.sign(md);

  const signerInfo = seq([
    int(1),
    seq([issuer, serial]),
    algo(OID.sha256),
    asn1.create(C.CONTEXT_SPECIFIC, 0, true, attrs),
    algo(OID.rsaEncryption),
    octets(signature),
  ]);

  const signedData = seq([
    int(1),
    set([algo(OID.sha256)]),
    seq([oid(OID.data)]),
    asn1.create(C.CONTEXT_SPECIFIC, 0, true, chain.map((c) => pki.certificateToAsn1(c))),
    set([signerInfo]),
  ]);

  const contentInfo = seq([oid(OID.signedData), asn1.create(C.CONTEXT_SPECIFIC, 0, true, [signedData])]);
  return binaryToBytes(der(contentInfo));
}

// ----- Reading signatures back -----

export interface ParsedSignature {
  digestAlgorithm: 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512' | null;
  /** messageDigest attribute, if the signer used signed attributes. */
  messageDigest: Uint8Array | null;
  /** Bytes that were signed: the attribute set re-tagged as SET, or null when the content was signed directly. */
  signedAttrsDer: string | null;
  signature: string;
  signer: forge.pki.Certificate | null;
  certificates: forge.pki.Certificate[];
  signingTime: Date | null;
}

const DIGESTS: Record<string, ParsedSignature['digestAlgorithm']> = {
  [OID.sha1]: 'SHA-1',
  [OID.sha256]: 'SHA-256',
  [OID.sha384]: 'SHA-384',
  [OID.sha512]: 'SHA-512',
};

/** Parses CMS SignedData from a signature's /Contents (trailing zero padding is fine). */
export function parseCms(contents: Uint8Array): ParsedSignature {
  // Signatures are zero-padded to fill their reserved space, so don't require the whole buffer to parse.
  const fromDer = asn1.fromDer as unknown as (bytes: string, options: object) => forge.asn1.Asn1;
  const root = fromDer(bytesToBinary(contents), { strict: false, parseAllBytes: false });
  const signedData = ((root.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[];
  const certificates: forge.pki.Certificate[] = [];
  for (const node of signedData) {
    if (node.tagClass === C.CONTEXT_SPECIFIC && node.type === 0) {
      for (const c of node.value as forge.asn1.Asn1[]) {
        try {
          certificates.push(pki.certificateFromAsn1(c));
        } catch {
          /* non-RSA certificates aren't supported by forge */
        }
      }
    }
  }
  const signerInfo = ((signedData[signedData.length - 1].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[]);
  const sid = signerInfo[1];
  const digestOid = asn1.derToOid((signerInfo[2].value as forge.asn1.Asn1[])[0].value as string);
  let k = 3;
  let messageDigest: Uint8Array | null = null;
  let signedAttrsDer: string | null = null;
  let signingTime: Date | null = null;
  if (signerInfo[k].tagClass === C.CONTEXT_SPECIFIC && signerInfo[k].type === 0) {
    const attrs = signerInfo[k].value as forge.asn1.Asn1[];
    signedAttrsDer = der(set(attrs));
    for (const a of attrs) {
      const [typeNode, values] = a.value as forge.asn1.Asn1[];
      const type = asn1.derToOid(typeNode.value as string);
      const v = (values.value as forge.asn1.Asn1[])[0];
      if (type === OID.messageDigest) messageDigest = binaryToBytes(v.value as string);
      if (type === OID.signingTime) {
        try {
          signingTime = v.type === T.UTCTIME ? asn1.utcTimeToDate(v.value as string) : asn1.generalizedTimeToDate(v.value as string);
        } catch {
          /* ignore */
        }
      }
    }
    k++;
  }
  const signature = signerInfo[k + 1].value as string;

  // Match the signer by serial number (issuerAndSerialNumber).
  let signer: forge.pki.Certificate | null = null;
  const sidParts = sid.value as forge.asn1.Asn1[];
  if (Array.isArray(sidParts) && sidParts.length === 2) {
    const serialHex = forge.util.bytesToHex(sidParts[1].value as string).replace(/^0+/, '');
    signer = certificates.find((c) => c.serialNumber.replace(/^0+/, '').toLowerCase() === serialHex.toLowerCase()) ?? null;
  }
  return {
    digestAlgorithm: DIGESTS[digestOid] ?? null,
    messageDigest,
    signedAttrsDer,
    signature,
    signer: signer ?? certificates[0] ?? null,
    certificates,
    signingTime,
  };
}

/** Checks an RSA signature over `data` (binary string) with the signer's public key. */
export function verifyRsa(cert: forge.pki.Certificate, algorithm: NonNullable<ParsedSignature['digestAlgorithm']>, data: string, signature: string): boolean {
  const md =
    algorithm === 'SHA-1' ? forge.md.sha1.create() : algorithm === 'SHA-384' ? forge.md.sha384.create() : algorithm === 'SHA-512' ? forge.md.sha512.create() : forge.md.sha256.create();
  md.update(data);
  try {
    return (cert.publicKey as forge.pki.rsa.PublicKey).verify(md.digest().getBytes(), signature);
  } catch {
    return false;
  }
}
