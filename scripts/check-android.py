"""Resolve or test the package-contained Android host without a device."""
import argparse
import os
import pathlib
import subprocess

root = pathlib.Path(__file__).resolve().parents[1]
host = root / "tests/native/android"
parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["resolve", "prepare", "test"])
args = parser.parse_args()
if not (os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")):
    raise SystemExit("An explicit Android development tools directory is required")
if args.action != "resolve" and not all((host / file).is_file() for file in ["app/gradle.lockfile", "gradle/verification-metadata.xml"]):
    raise SystemExit("Missing native dependency lock or checksum metadata")
command = [str(host / "gradlew"), "--no-daemon", "--console=plain", ":app:testDebugUnitTest", ":app:assembleDebug"]
if args.action == "resolve":
    command += ["--write-locks", "--write-verification-metadata", "sha256"]
else:
    command += ["--dependency-verification=strict"]
    if args.action == "test":
        command += ["--offline"]
subprocess.run(command, cwd=host, check=True, timeout=600)
