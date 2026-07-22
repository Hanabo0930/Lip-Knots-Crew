/**
 * POSIX-only secret file permission checks.
 * Windows does not preserve writeFile({ mode: 0o600 }); Node often reports 0o666 (438).
 */

export function supportsPosixFileModeChecks() {
  return process.platform !== "win32";
}

/** True when group/other can read or write the file (POSIX only). */
export function hasUnsafeConfigFilePermissions(stat) {
  if (!supportsPosixFileModeChecks()) {
    return false;
  }
  return (stat.mode & 0o077) !== 0;
}

/** Assert generated secret outputs are owner-only (0o600) on POSIX only. */
export function assertOwnerOnlyGeneratedFileMode(stat, label, assert) {
  if (!supportsPosixFileModeChecks()) {
    return;
  }
  assert.equal(stat.mode & 0o777, 0o600, `${label} mode`);
}
