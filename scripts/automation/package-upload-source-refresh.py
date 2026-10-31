"""Build private upload packages with the existing strict readiness verifier."""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import stat
import sys
import zipfile

spec = importlib.util.spec_from_file_location("upload_readiness", pathlib.Path(__file__).with_name("check-hosting-api-readiness.py"))
readiness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(readiness)


def build_packages(root, environments, output):
    root, output = pathlib.Path(root).resolve(), pathlib.Path(output).resolve()
    readiness.require(set(environments) == set(readiness.REQUIRED), "REFRESH_EXACT_PAIR_REQUIRED")
    readiness.require(output.is_dir() and output.stat().st_mode & 0o077 == 0, "REFRESH_PRIVATE_DIRECTORY_REQUIRED")
    expected = readiness.expected_files(root, strict=True)
    optional = readiness.expected_packaging_files(root)
    payloads = {}
    for name in sorted({**expected, **optional}):
        file = root / "functions" / name
        for ancestor in (file, *file.parents):
            readiness.require(not stat.S_ISLNK(ancestor.lstat().st_mode), "REFRESH_SOURCE_LINK_REJECTED")
        info = file.lstat()
        readiness.require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 2 * 1024 * 1024,
                          "REFRESH_SOURCE_FILE_REJECTED")
        fd = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as stream:
            data = stream.read(2 * 1024 * 1024 + 1)
            after = os.fstat(stream.fileno())
        readiness.require((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) ==
                          (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), "REFRESH_SOURCE_CHANGED")
        readiness.require(readiness.digest(data) == {**expected, **optional}[name], "REFRESH_SOURCE_CHANGED")
        payloads[name] = data
    results = {}
    for name in readiness.REQUIRED:
        env = environments[name]
        readiness.require(type(env) is dict, "REFRESH_ENV_REJECTED")
        config = "".join(key + "=" + env.get(key, "") + "\n" for key in sorted(readiness.DEPLOYMENT_CONFIG_KEYS)).encode()
        readiness.verify_deployment_config(config, env)
        destination = output / (name + ".zip")
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream, zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
            # Source-only PATCH leaves the official runtime configuration in
            # place. Private dotenv is compared above, never placed in the ZIP.
            for path, data in sorted(payloads.items()):
                entry = zipfile.ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = (stat.S_IFREG | 0o644) << 16
                entry.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(entry, data)
        blob = destination.read_bytes()
        readiness.verify_archive(blob, expected, strict=True, optional=optional)
        results[name] = {"path": str(destination), "bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest(),
                         "md5Hash": __import__("base64").b64encode(hashlib.md5(blob).digest()).decode()}
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    try:
        data = sys.stdin.buffer.read(65537)
        readiness.require(len(data) <= 65536, "REFRESH_ENV_TOO_LARGE")
        result = build_packages(args.root, json.loads(data), args.output)
        print(json.dumps(result))
    except Exception as error:
        code = str(error) if isinstance(error, readiness.ReadinessError) else "REFRESH_PACKAGE_BUILD_FAILED"
        print(code if __import__("re").fullmatch(r"[A-Z_]+", code) else "REFRESH_PACKAGE_BUILD_FAILED", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
