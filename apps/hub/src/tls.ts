// Local certificate authority + server certificate, generated on first run.
// shortcut: shells out to the `openssl` CLI (present on macOS/Linux); swap for a JS X.509 library if the hub must run on stock Windows.
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

export type Certs = { key: string; cert: string; ca: string; caFingerprint: string };

const openssl = (cwd: string, ...args: string[]) => execFileSync('openssl', args, { cwd, stdio: 'pipe' });

export function ensureCerts(dataDir: string, names: string[]): Certs {
  const dir = join(dataDir, 'tls');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = (f: string) => join(dir, f);

  if (!existsSync(p('ca.crt')) || !existsSync(p('ca.key'))) {
    writeFileSync(p('ca.cnf'), [
      '[req]', 'distinguished_name=dn', 'x509_extensions=v3', 'prompt=no',
      '[dn]', 'CN=NRVL Stream Deck Local CA',
      '[v3]', 'basicConstraints=critical,CA:TRUE', 'keyUsage=critical,keyCertSign,cRLSign', 'subjectKeyIdentifier=hash',
    ].join('\n'));
    openssl(dir, 'req', '-x509', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
      '-keyout', 'ca.key', '-out', 'ca.crt', '-config', 'ca.cnf');
    chmodSync(p('ca.key'), 0o600);
  }

  // Reissue the server certificate when the host's names/IPs change or it is within 30 days of expiry.
  const sans = [...new Set(['localhost', '127.0.0.1', ...names])].sort();
  const sanLine = sans.map((n) => `${isIP(n) ? 'IP' : 'DNS'}:${n}`).join(',');
  const current = existsSync(p('server.crt')) && existsSync(p('server.key')) && existsSync(p('server.san'))
    && readFileSync(p('server.san'), 'utf8') === sanLine
    && new X509Certificate(readFileSync(p('server.crt'))).validToDate.getTime() - Date.now() > 30 * 86400_000;
  if (!current) {
    writeFileSync(p('server.cnf'), [
      '[req]', 'distinguished_name=dn', 'prompt=no',
      '[dn]', 'CN=NRVL Stream Deck Hub',
      '[v3]', 'basicConstraints=CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth', `subjectAltName=${sanLine}`,
    ].join('\n'));
    openssl(dir, 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-config', 'server.cnf');
    // 825 days is the longest validity iOS accepts for a TLS server certificate.
    openssl(dir, 'x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
      '-out', 'server.crt', '-days', '825', '-sha256', '-extfile', 'server.cnf', '-extensions', 'v3');
    chmodSync(p('server.key'), 0o600);
    writeFileSync(p('server.san'), sanLine);
  }

  const ca = readFileSync(p('ca.crt'), 'utf8');
  return {
    key: readFileSync(p('server.key'), 'utf8'),
    cert: readFileSync(p('server.crt'), 'utf8'),
    ca,
    caFingerprint: createHash('sha256').update(new X509Certificate(ca).raw).digest('hex'),
  };
}
