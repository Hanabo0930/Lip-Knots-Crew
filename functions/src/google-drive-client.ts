import { google } from "googleapis";

type DriveClient = ReturnType<typeof google.drive>;

let readonlyAuth: InstanceType<typeof google.auth.GoogleAuth> | null = null;
let readonlyDrive: DriveClient | null = null;
let writableAuth: InstanceType<typeof google.auth.GoogleAuth> | null = null;
let writableDrive: DriveClient | null = null;

export function getReadonlyDriveClient(): DriveClient {
  readonlyAuth ??= new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  readonlyDrive ??= google.drive({ version: "v3", auth: readonlyAuth });
  return readonlyDrive;
}

export function getWritableDriveClient(): DriveClient {
  writableAuth ??= new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  writableDrive ??= google.drive({ version: "v3", auth: writableAuth });
  return writableDrive;
}
