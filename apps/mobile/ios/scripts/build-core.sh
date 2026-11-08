#!/bin/sh
# Builds the Rust core for iOS and the simulator, and generates its Swift bindings.
# Run on a Mac: the iOS targets need Xcode's linker and SDKs.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ios=$(dirname "$here")
core=$(dirname "$ios")/core
frameworks="$ios/Frameworks"
generated="$ios/Generated"

cd "$core"
for target in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
  cargo build --release --target "$target" -p runova-ffi
done

cargo run -p runova-ffi --bin uniffi-bindgen -- generate \
  --library target/aarch64-apple-ios/release/librunova_ffi.a \
  --language swift --out-dir "$generated"

simulator="$core/target/universal-sim/release"
mkdir -p "$simulator"
lipo -create \
  target/aarch64-apple-ios-sim/release/librunova_ffi.a \
  target/x86_64-apple-ios/release/librunova_ffi.a \
  -output "$simulator/librunova_ffi.a"

headers=$(mktemp -d)
cp "$generated/runova_ffiFFI.h" "$headers/"
cp "$generated/runova_ffiFFI.modulemap" "$headers/module.modulemap"

rm -rf "$frameworks/RunovaCore.xcframework"
mkdir -p "$frameworks"
xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/librunova_ffi.a -headers "$headers" \
  -library "$simulator/librunova_ffi.a" -headers "$headers" \
  -output "$frameworks/RunovaCore.xcframework"
rm -rf "$headers"
