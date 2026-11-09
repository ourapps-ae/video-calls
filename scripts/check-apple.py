"""Compile the package-contained Apple host; simulator execution is separate."""
import argparse
import os
import pathlib
import shutil
import subprocess

root = pathlib.Path(__file__).resolve().parents[1]
os.environ.setdefault("USER", "builder")
os.environ.setdefault("LOGNAME", "builder")
host = root / "tests/native/apple"
parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["generate", "prepare", "build"])
parser.add_argument("--destination", choices=["phone", "television", "catalyst"], default="phone")
parser.add_argument("--architecture", choices=["arm64"])
args = parser.parse_args()
project = host / "MediaHost.xcodeproj"
cache = host / ".packages"
resolved = project / "project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
lock = host / "Package.resolved"
xcodegen = shutil.which("xcodegen")
if not xcodegen:
    raise SystemExit("tool-unavailable")
subprocess.run([str(pathlib.Path(xcodegen).resolve()), "generate", "--spec", str(host / "project.yml")], cwd=host, check=True, timeout=60)
if lock.exists():
    resolved.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(lock, resolved)
if args.action == "generate":
    raise SystemExit(0)
base = ["xcodebuild", "-quiet", "-project", str(project), "-clonedSourcePackagesDirPath", str(cache),
        "-packageCachePath", str(host / ".package-cache"), "-disablePackageRepositoryCache"]
if args.action == "prepare":
    subprocess.run([*base, "-resolvePackageDependencies", "-scheme", "MediaHost"], check=True, timeout=600)
    if lock.exists() and lock.read_bytes() != resolved.read_bytes():
        raise SystemExit("Resolved lock changed; review dependency resolution before adoption")
    shutil.copyfile(resolved, lock)
else:
    if not lock.is_file():
        raise SystemExit("Missing resolved Apple dependency lock")
    scheme, destination = {
        "phone": ("MediaHost", "generic/platform=iOS Simulator"),
        "television": ("MediaTelevision", "generic/platform=tvOS Simulator"),
        "catalyst": ("MediaHost", "generic/platform=macOS,variant=Mac Catalyst"),
    }[args.destination]
    command = "build" if args.destination == "catalyst" else "build-for-testing"
    subprocess.run([*base, "-scheme", scheme, "-destination", destination,
                    "-derivedDataPath", str(host / (".derived-" + args.destination)),
                    "-disableAutomaticPackageResolution", "-onlyUsePackageVersionsFromResolvedFile",
                    "CODE_SIGNING_ALLOWED=NO", *(["ARCHS=" + args.architecture] if args.architecture else []), command], check=True, timeout=600)
