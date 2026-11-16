export const AUTH_SECOND = 1_794_730_000;

export function staffRevocationCases(timestamp, second = AUTH_SECOND) {
  const cutoff = timestamp(second, 1_000);
  const refreshedOld = { auth_time: second - 1, iat: second + 10 };
  const newSession = { auth_time: second + 1, iat: second + 10 };
  const active = { active: true, companyId: 'company-a', staffId: 'staff-revocation' };
  return [
    { name: 'legacy without identity', identity: null, claims: {}, allowed: true },
    { name: 'legacy without cutoff', identity: active, claims: {}, allowed: true },
    { name: 'legacy null cutoff', identity: { ...active, revokedAt: null }, claims: {}, allowed: true },
    { name: 'disabled identity', identity: { ...active, active: false, revokedAt: cutoff }, claims: newSession, allowed: false },
    { name: 'reactivated identity with refreshed old token', identity: { ...active, revokedAt: cutoff }, claims: refreshedOld, allowed: false },
    { name: 'same second before fractional cutoff', identity: { ...active, revokedAt: cutoff }, claims: { auth_time: second }, allowed: false },
    { name: 'same second at exact cutoff', identity: { ...active, revokedAt: timestamp(second, 0) }, claims: { auth_time: second }, allowed: true },
    { name: 'reactivated identity with newly authenticated token', identity: { ...active, revokedAt: cutoff }, claims: newSession, allowed: true },
    { name: 'iat only', identity: { ...active, revokedAt: cutoff }, claims: { iat: second + 10 }, allowed: false },
    { name: 'string authentication time', identity: { ...active, revokedAt: cutoff }, claims: { auth_time: String(second + 1) }, allowed: false },
    { name: 'fractional authentication time', identity: { ...active, revokedAt: cutoff }, claims: { auth_time: second + 1.5 }, allowed: false },
    { name: 'out of range authentication time', identity: { ...active, revokedAt: cutoff }, claims: { auth_time: 253402300800 }, allowed: false },
    { name: 'malformed cutoff', identity: { ...active, revokedAt: String(second) }, claims: newSession, allowed: false },
    { name: 'cross-company identity', identity: { ...active, companyId: 'company-b', revokedAt: cutoff }, claims: newSession, allowed: false },
    { name: 'different staff identity', identity: { ...active, staffId: 'different-staff', revokedAt: cutoff }, claims: newSession, allowed: false },
  ];
}
