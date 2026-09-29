/**
 * Minimal ambient types for `node-forge`.
 *
 * ## Why this file exists instead of a devDependency
 *
 * `@types/node-forge` is the obvious answer, and adding it is a one-line
 * change to `package.json` — but that would break CI. `npm ci` validates
 * `package.json` against `package-lock.json` and hard-fails when they
 * disagree, and regenerating the lockfile is a network write outside this
 * change's remit. So the types are declared here, in the repo, next to the only
 * module that uses them.
 *
 * ## Why depending on it at all is defensible
 *
 * `node-forge` is a **direct dependency of `samlify`**, and `samlify` is the
 * library `@better-auth/sso` uses for all SAML (`dist/index.mjs:4`). It is
 * therefore already in the dependency graph and in the lockfile at a pinned
 * version — this is not a phantom transitive that can vanish. Declaring it
 * explicitly as a devDependency would still be the tidier end state, and is
 * worth doing in a commit that is also allowed to touch the lockfile.
 *
 * ## Scope
 *
 * Only the three calls `__tests__/fixtures/mock-idp.ts` makes are typed. This is
 * deliberately not a full port of the upstream typings: it is enough to mint a
 * self-signed certificate, and no more, so it cannot rot silently against a
 * large surface nobody here uses. It is an ambient `declare module`, so it
 * applies project-wide — if `node-forge` ever needs real types elsewhere,
 * delete this file in favour of `@types/node-forge`.
 */
declare module "node-forge" {
  interface ForgeCertificate {
    publicKey: unknown;
    serialNumber: string;
    validity: { notBefore: Date; notAfter: Date };
    setSubject(attrs: Array<{ name: string; value: string }>): void;
    setIssuer(attrs: Array<{ name: string; value: string }>): void;
    sign(key: unknown, md?: unknown): void;
  }

  interface ForgeRsa {
    privateKeyFromPem(pem: string): {
      publicKey: unknown;
    };
    publicKeyFromPem(pem: string): unknown;
    createCertificate(): ForgeCertificate;
    certificateToPem(cert: ForgeCertificate): string;
  }

  interface ForgeMd {
    sha256: { create(): unknown };
  }

  const forge: {
    pki: ForgeRsa;
    md: ForgeMd;
  };

  export default forge;
}
