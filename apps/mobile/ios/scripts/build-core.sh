#!/bin/sh
# Builds the Rust core for iOS and the simulator, and generates its Swift bindings.
# Run on a Mac: the iOS targets need Xcode's linker and SDKs.
#
#   build-core.sh              the device and both simulators, in the release profile (shipping)
#   build-core.sh --simulator  only the Apple silicon simulator, in the ci profile (tests)
#
# The release profile links the whole core in one LTO pass with one codegen unit, which on the CI
# Mac takes over 20 minutes for runova-ffi on each target, so three of them no longer fit in the
# job's 45 minutes. The tests run on one simulator and do not need the smallest binary.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ios=$(dirname "$here")
core=$(dirname "$ios")/core
frameworks="$ios/Frameworks"
generated="$ios/Generated"

case "${1:-}" in
  "")
    profile=release
    device=aarch64-apple-ios
    simulators="aarch64-apple-ios-sim x86_64-apple-ios"
    ;;
  --simulator)
    profile=ci
    device=
    simulators=aarch64-apple-ios-sim
    ;;
  *)
    echo "usage: $0 [--simulator]" >&2
    exit 2
    ;;
esac

# The oldest iOS the app runs on, the same as deploymentTarget in project.yml. Without it rustc links
# for iOS 10 while the C code in ring and aws-lc is built for the SDK's own version, and the link
# fails on ___chkstk_darwin.
export IPHONEOS_DEPLOYMENT_TARGET=16.0

# Cargo's output folder. CI points CARGO_TARGET_DIR outside the checkout, so the next run on the
# Mac builds only what changed instead of everything from scratch.
out=${CARGO_TARGET_DIR:-$core/target}
library() { echo "$out/$1/$profile/librunova_ffi.a"; }

cd "$core"
for target in $device $simulators; do
  cargo build --profile "$profile" --target "$target" -p runova-ffi
done

set -- $simulators
cargo run -p runova-bindgen -- generate \
  --library "$(library "${device:-$1}")" \
  --language swift --out-dir "$generated"

# One library for all the simulators: lipo when there are two architectures.
if [ $# -gt 1 ]; then
  simulator="$out/universal-sim/$profile/librunova_ffi.a"
  mkdir -p "$(dirname "$simulator")"
  lipo -create $(for target in "$@"; do library "$target"; done) -output "$simulator"
else
  simulator=$(library "$1")
fi

headers=$(mktemp -d)
cp "$generated/runova_ffiFFI.h" "$headers/"
cp "$generated/runova_ffiFFI.modulemap" "$headers/module.modulemap"

rm -rf "$frameworks/RunovaCore.xcframework"
mkdir -p "$frameworks"
if [ -n "$device" ]; then
  set -- -library "$(library "$device")" -headers "$headers"
else
  set --
fi
xcodebuild -create-xcframework "$@" \
  -library "$simulator" -headers "$headers" \
  -output "$frameworks/RunovaCore.xcframework"
rm -rf "$headers"
