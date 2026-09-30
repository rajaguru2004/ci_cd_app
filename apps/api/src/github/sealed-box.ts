import sodium from 'libsodium-wrappers';

/**
 * Encrypts a value for a GitHub Actions secret: a libsodium sealed box against the
 * repository's public key, which is what GitHub requires. Only GitHub's key can open it; the
 * console cannot read a secret back once it is stored.
 */
export async function sealForGithub(value: string, repoPublicKeyBase64: string): Promise<string> {
  await sodium.ready;
  const key = sodium.from_base64(repoPublicKeyBase64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), key);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}
