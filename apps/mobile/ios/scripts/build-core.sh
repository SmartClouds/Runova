#!/bin/sh
# Builds the Rust core for iOS and the simulator, and generates its Swift bindings.
# Run on a Mac: the iOS targets need Xcode's linker and SDKs.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ios=$(dirname "$here")
core=$(dirname "$ios")/core
frameworks="$ios/Frameworks"
generated="$ios/Generated"

# The oldest iOS the app runs on, the same as deploymentTarget in project.yml. Without it rustc links
# for iOS 10 while the C code in ring and aws-lc is built for the SDK's own version, and the link
# fails on ___chkstk_darwin.
export IPHONEOS_DEPLOYMENT_TARGET=16.0

# Cargo's output folder. CI points CARGO_TARGET_DIR outside the checkout, so the next run on the
# Mac builds only what changed instead of all three targets from scratch.
out=${CARGO_TARGET_DIR:-$core/target}

cd "$core"
for target in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
  cargo build --release --target "$target" -p runova-ffi
done

cargo run -p runova-ffi --bin uniffi-bindgen -- generate \
  --library "$out/aarch64-apple-ios/release/librunova_ffi.a" \
  --language swift --out-dir "$generated"

simulator="$out/universal-sim/release"
mkdir -p "$simulator"
lipo -create \
  "$out/aarch64-apple-ios-sim/release/librunova_ffi.a" \
  "$out/x86_64-apple-ios/release/librunova_ffi.a" \
  -output "$simulator/librunova_ffi.a"

headers=$(mktemp -d)
cp "$generated/runova_ffiFFI.h" "$headers/"
cp "$generated/runova_ffiFFI.modulemap" "$headers/module.modulemap"

rm -rf "$frameworks/RunovaCore.xcframework"
mkdir -p "$frameworks"
xcodebuild -create-xcframework \
  -library "$out/aarch64-apple-ios/release/librunova_ffi.a" -headers "$headers" \
  -library "$simulator/librunova_ffi.a" -headers "$headers" \
  -output "$frameworks/RunovaCore.xcframework"
rm -rf "$headers"
