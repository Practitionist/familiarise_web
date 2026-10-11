/** Client-safe password limits shared by the auth forms and the server hooks. */
export const PASSWORD_MIN_LENGTH = 8;
/** bcrypt ignores everything past the 72nd byte of the UTF-8 encoding. */
export const PASSWORD_MAX_BYTES = 72;

export function passwordByteLength(password: string): number {
  return new TextEncoder().encode(password).length;
}

export function passwordTooLong(password: string): boolean {
  return passwordByteLength(password) > PASSWORD_MAX_BYTES;
}

export const PASSWORD_RULE_HINT =
  "At least 8 characters and at most 72 bytes (most characters are 1 byte; emoji and some scripts use up to 4).";
