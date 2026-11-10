#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# package-plugin.sh — build the OBS plugin package on Linux (x64) or macOS
# (Apple Silicon).
#
# Output:
#   Linux:  release/stream-live-translate-obs-linux-x64-<version>.tar.gz
#   macOS:  release/stream-live-translate-obs-macos-arm64-<version>.tar.gz
#           (contains stream-live-translate.plugin bundle)
#
# Prerequisites: Rust toolchain, C/C++ compiler, cmake, git.
#
# Like the Windows script this does NOT build OBS itself. It needs:
#   * libobs headers  -> shallow clone of obs-studio at any 30+ tag
#   * Linux: a stub libobs.so with soname libobs.so.0 (symbols resolve at
#     runtime against the installed OBS)
#   * macOS: nothing extra; the module is linked with -undefined dynamic_lookup
#
# One DLL/SO for every OBS 30+ release: source registration uses
# obs_register_source_s(info, size); libobs copies only `size` bytes into
# its own (possibly larger) struct and zero-fills the rest. So any 30+
# header tag works on OBS 30, 31, 32, 33 and later. OBS_VERSION is optional:
# when unset we detect the local OBS, otherwise we use a 30.2.3 baseline.
# ---------------------------------------------------------------------------
set -euo pipefail

BASELINE_OBS_VERSION="30.2.3"
OBS_VERSION="${OBS_VERSION:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/build/plugin-sdk"
STAGE="$ROOT/build/stage-unix"

step() { printf '\n==> %s\n' "$*"; }

# Best-effort detection of the installed OBS version. Failure is harmless:
# the baseline headers are compatible with every OBS 30+ release.
detect_obs_version() {
    local v=""
    case "$(uname -s)" in
        Linux)
            if command -v dpkg-query >/dev/null 2>&1; then
                v="$(dpkg-query -W -f='${Version}' obs-studio 2>/dev/null || true)"
            fi
            if [ -z "$v" ] && command -v rpm >/dev/null 2>&1; then
                v="$(rpm -q --qf '%{VERSION}' obs-studio 2>/dev/null || true)"
            fi
            ;;
        Darwin)
            if [ -f "/Applications/OBS.app/Contents/Info.plist" ] && \
               command -v /usr/libexec/PlistBuddy >/dev/null 2>&1; then
                v="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
                     /Applications/OBS.app/Contents/Info.plist 2>/dev/null || true)"
            fi
            ;;
    esac
    if [[ "$v" =~ ^([0-9]+\.[0-9]+\.[0-9]+) ]]; then
        printf '%s' "${BASH_REMATCH[1]}"
    fi
}

VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/Cargo.toml" | head -n1)"
step "Packaging Stream Live Translate OBS plugin v$VERSION"

case "$(uname -s)" in
    Linux)  OS=linux ;;
    Darwin) OS=macos ;;
    *) echo "unsupported platform: $(uname -s)" >&2; exit 1 ;;
esac

DETECTED_OBS_VERSION="$(detect_obs_version)"
if [ -n "$DETECTED_OBS_VERSION" ]; then
    echo "    Detected OBS $DETECTED_OBS_VERSION (headers stay at the 30+ baseline)"
fi
if [ -z "$OBS_VERSION" ]; then
    # Oldest supported headers => smallest source-info struct => libobs only
    # ever zero-extends it, on any OBS 30+ host. One module for all releases.
    OBS_VERSION="$BASELINE_OBS_VERSION"
    echo "    Using baseline headers $OBS_VERSION -> one module for all OBS 30+ releases"
fi

# --- 1. Engine -------------------------------------------------------------
step "Building Rust engine (release)"
(cd "$ROOT" && cargo build --release)

if [ "$OS" = "linux" ]; then
    ENGINE="$ROOT/target/release/stream-live-translate"
else
    ENGINE="$ROOT/target/release/stream-live-translate"
fi
[ -f "$ENGINE" ] || { echo "engine binary missing: $ENGINE" >&2; exit 1; }

# --- 2. OBS SDK headers ------------------------------------------------------
# Per-version checkout so switching OBS versions never reuses stale headers.
# A tag that is not published (beta/custom build) falls back to the 30.2.3
# baseline, which is still ABI-compatible with all OBS 30+ releases.
mkdir -p "$WORK"
clone_headers() {
    git clone --depth 1 --branch "$1" \
        https://github.com/obsproject/obs-studio "$2" >/dev/null 2>&1 || true
}
HEADER_TAG="$OBS_VERSION"
OBS_SRC="$WORK/obs-studio-$HEADER_TAG"
if [ ! -f "$OBS_SRC/libobs/obs-module.h" ]; then
    step "Fetching libobs headers (obs-studio $HEADER_TAG, shallow clone)"
    clone_headers "$HEADER_TAG" "$OBS_SRC"
    if [ ! -f "$OBS_SRC/libobs/obs-module.h" ]; then
        echo "    Tag $HEADER_TAG unavailable; falling back to $BASELINE_OBS_VERSION headers"
        rm -rf "$OBS_SRC"
        HEADER_TAG="$BASELINE_OBS_VERSION"
        OBS_SRC="$WORK/obs-studio-$HEADER_TAG"
        if [ ! -f "$OBS_SRC/libobs/obs-module.h" ]; then
            clone_headers "$HEADER_TAG" "$OBS_SRC"
        fi
    fi
fi
[ -f "$OBS_SRC/libobs/obs-module.h" ] || {
    echo "failed to fetch libobs headers" >&2; exit 1; }
step "libobs headers: $HEADER_TAG"

# --- 3. Platform-specific link target ---------------------------------------
CMAKE_EXTRA=()
if [ "$OS" = "linux" ]; then
    STUB_DIR="$WORK/sdk-lib"
    mkdir -p "$STUB_DIR"
    if [ ! -f "$STUB_DIR/libobs.so" ]; then
        step "Creating stub libobs.so (soname libobs.so.0)"
        printf '/* link-time stub; real symbols come from OBS at runtime */\n' \
            > "$STUB_DIR/stub.c"
        cc -shared -Wl,-soname,libobs.so.0 -o "$STUB_DIR/libobs.so" "$STUB_DIR/stub.c"
    fi
    CMAKE_EXTRA+=("-DOBS_STUB_LIB=$STUB_DIR/libobs.so")
fi

# --- 4. Build the plugin -----------------------------------------------------
step "Building plugin (CMake)"
BUILD_DIR="$ROOT/build/plugin-build-$OS"
cmake -S "$ROOT/plugin" -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DLIBOBS_INCLUDE_DIR="$OBS_SRC/libobs" \
    "${CMAKE_EXTRA[@]:-}"
cmake --build "$BUILD_DIR"

# --- 5. Assemble --------------------------------------------------------------
rm -rf "$STAGE"
mkdir -p "$ROOT/release"

if [ "$OS" = "linux" ]; then
    SO="$(find "$BUILD_DIR" -name 'stream-live-translate.so' | head -n1)"
    [ -n "$SO" ] || { echo "plugin .so not found" >&2; exit 1; }
    PKG="$STAGE/stream-live-translate"
    mkdir -p "$PKG/bin/64bit" "$PKG/data/locale" "$PKG/data/engine"
    cp "$SO" "$PKG/bin/64bit/"
    cp "$ROOT"/plugin/locale/*.ini "$PKG/data/locale/"
    cp "$ENGINE" "$PKG/data/engine/"
    cp "$ROOT/README.md" "$PKG/README.md"

    OUT="$ROOT/release/stream-live-translate-obs-linux-x64-$VERSION.tar.gz"
    step "Creating $OUT"
    tar -czf "$OUT" -C "$STAGE" stream-live-translate
else
    # macOS: .plugin bundle layout expected by OBS.
    DYLIB="$(find "$BUILD_DIR" -name 'stream-live-translate' -type f | head -n1)"
    [ -n "$DYLIB" ] || { echo "plugin module not found" >&2; exit 1; }
    BUNDLE="$STAGE/stream-live-translate.plugin"
    mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources/data/locale" \
             "$BUNDLE/Contents/Resources/data/engine"
    cp "$DYLIB" "$BUNDLE/Contents/MacOS/stream-live-translate"
    chmod +x "$BUNDLE/Contents/MacOS/stream-live-translate"
    cp "$ROOT"/plugin/locale/*.ini "$BUNDLE/Contents/Resources/data/locale/"
    cp "$ENGINE" "$BUNDLE/Contents/Resources/data/engine/"
    cat > "$BUNDLE/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.streamlivetranslate.obs-plugin</string>
    <key>CFBundleName</key>
    <string>Stream Live Translate</string>
    <key>CFBundleVersion</key>
    <string>$VERSION</string>
</dict>
</plist>
EOF
    cp "$ROOT/README.md" "$STAGE/README.md"

    OUT="$ROOT/release/stream-live-translate-obs-macos-arm64-$VERSION.tar.gz"
    step "Creating $OUT"
    tar -czf "$OUT" -C "$STAGE" stream-live-translate.plugin README.md
fi

# --- 6. Checksum ---------------------------------------------------------------
if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$ROOT/release" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" )
else
    ( cd "$ROOT/release" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256" )
fi

step "Done: $OUT"
if [ "$OS" = "linux" ]; then
    echo "    Install: extract into ~/.config/obs-studio/plugins/"
else
    echo "    Install: extract into ~/Library/Application Support/obs-studio/plugins/"
fi
echo "    Supports: every OBS Studio 30+ release (30/31/32/33/...) with one module"
