import { readFile } from "node:fs/promises";

const appSource = await readFile("apps/staff/src/App.tsx", "utf8");
const failures = [];

assert(
  /type DeviceSession = \{ id:string; deviceId\?:string; uid\?:string;/u.test(appSource),
  "Device rows must expose the stable device and Firebase Auth identities"
);
assert(
  /const currentDeviceId=useMemo\(\(\)=>getOrCreateDeviceId\(\),\[\]\)/u.test(appSource),
  "The browser device identity must stay stable for the mounted Staff app"
);
assert(
  /registerDeviceSession"\); const r=await c\(\{deviceId:currentDeviceId,/u.test(appSource),
  "Device registration must use the same stable browser identity"
);
assert(
  /if\(device\.id===deviceSessionId\)return true/u.test(appSource),
  "The server-issued session id must remain the primary current-device match"
);
assert(
  /user\?\.uid&&device\.deviceId===currentDeviceId&&device\.uid===user\.uid/u.test(appSource),
  "The current-device fallback must match both stable device id and auth id"
);
assert(
  /currentTarget=target\?isCurrentDevice\(target\):id===deviceSessionId/u.test(appSource)
    && /\{isCurrentDevice\(device\)\?"この端末 \/ ":""\}/u.test(appSource),
  "The same current-device predicate must drive self sign-out and the marker"
);

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Staff current-device indicator checks passed (6 assertions)");

function assert(condition, message) {
  if (!condition) failures.push(message);
}
