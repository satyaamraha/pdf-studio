import forge from 'node-forge';

/**
 * Digital IDs (certificate + private key) for signing. They're kept on this device as
 * the original password-protected .p12 container; the password is never stored.
 */
export interface DigitalId {
  id: string;
  name: string;
  email: string;
  organization: string;
  issuer: string;
  selfSigned: boolean;
  notBefore: string;
  notAfter: string;
  /** SHA-256 fingerprint of the certificate, for display. */
  fingerprint: string;
  /** The .p12 file, base64. */
  p12: string;
}

export interface UnlockedId {
  key: forge.pki.rsa.PrivateKey;
  /** Signer's certificate first, then any others in the file. */
  chain: forge.pki.Certificate[];
}

const KEY = 'pdf-studio:digital-ids';

export function loadIds(): DigitalId[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]') as DigitalId[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function storeIds(list: DigitalId[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

const attr = (cert: forge.pki.Certificate, field: 'subject' | 'issuer', name: string) =>
  String(cert[field].getField(name)?.value ?? '');

function describe(cert: forge.pki.Certificate, p12Base64: string): DigitalId {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const fingerprint = forge.md.sha256
    .create()
    .update(der)
    .digest()
    .toHex()
    .toUpperCase()
    .match(/.{2}/g)!
    .join(':');
  const subjectCN = attr(cert, 'subject', 'CN') || attr(cert, 'subject', 'O') || 'Unnamed ID';
  const issuerCN = attr(cert, 'issuer', 'CN') || attr(cert, 'issuer', 'O') || 'Unknown issuer';
  return {
    id: fingerprint.replace(/:/g, '').slice(0, 24),
    name: subjectCN,
    email: attr(cert, 'subject', 'E') || attr(cert, 'subject', 'emailAddress'),
    organization: attr(cert, 'subject', 'O'),
    issuer: issuerCN,
    selfSigned: cert.isIssuer(cert),
    notBefore: cert.validity.notBefore.toISOString(),
    notAfter: cert.validity.notAfter.toISOString(),
    fingerprint,
    p12: p12Base64,
  };
}

/** Opens a .p12/.pfx with its password. Throws a readable error on a wrong password or unsupported key. */
export function unlockP12(p12Base64: string, password: string): UnlockedId {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.decode64(p12Base64));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    if (/mac|password|decrypt|invalid/i.test(msg)) throw new Error('Wrong password for this digital ID.');
    throw new Error(`This file couldn't be read as a digital ID (${msg}).`);
  }
  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const key = keyBags.find((b) => b.key)?.key as forge.pki.rsa.PrivateKey | undefined;
  if (!key) throw new Error('This digital ID has no RSA private key. (Only RSA IDs are supported for now.)');
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [])
    .map((b) => b.cert)
    .filter((c): c is forge.pki.Certificate => !!c);
  // The signer's certificate is the one matching the private key.
  const signer = certs.find((c) => {
    const pub = c.publicKey as forge.pki.rsa.PublicKey;
    return pub.n && pub.n.equals(key.n);
  });
  if (!signer) throw new Error("This digital ID's certificate doesn't match its key.");
  return { key, chain: [signer, ...certs.filter((c) => c !== signer)] };
}

/** Reads a .p12/.pfx file, checking the password, and returns the ID to keep. */
export function importP12(bytes: Uint8Array, password: string): DigitalId {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const b64 = forge.util.encode64(bin);
  const { chain } = unlockP12(b64, password);
  return describe(chain[0], b64);
}

/**
 * Creates a self-signed digital ID. It proves the document wasn't changed after signing,
 * but other people's apps won't trust who signed it unless they choose to trust it.
 */
export async function createSelfSignedId(opts: { name: string; email: string; organization: string; password: string; years: number }): Promise<DigitalId> {
  // The browser's key generator is far faster than doing it in JavaScript.
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let bin = '';
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const key = forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(bin)) as forge.pki.rsa.PrivateKey;
  const publicKey = forge.pki.setRsaPublicKey(key.n, key.e);

  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(15));
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 60_000);
  cert.validity.notAfter = new Date(now.getFullYear() + opts.years, now.getMonth(), now.getDate());
  const subject: forge.pki.CertificateField[] = [{ name: 'commonName', value: opts.name }];
  if (opts.organization) subject.push({ name: 'organizationName', value: opts.organization });
  if (opts.email) subject.push({ name: 'emailAddress', value: opts.email });
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'extKeyUsage', emailProtection: true },
    { name: 'subjectKeyIdentifier' },
    ...(opts.email ? [{ name: 'subjectAltName', altNames: [{ type: 1, value: opts.email }] }] : []),
  ]);
  cert.sign(key, forge.md.sha256.create());

  const p12 = forge.pkcs12.toPkcs12Asn1(key, [cert], opts.password, { algorithm: 'aes256', friendlyName: opts.name });
  return describe(cert, forge.util.encode64(forge.asn1.toDer(p12).getBytes()));
}

export function p12Bytes(id: DigitalId): Uint8Array {
  return Uint8Array.from(forge.util.decode64(id.p12), (c) => c.charCodeAt(0));
}
