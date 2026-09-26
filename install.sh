#!/bin/sh
# gotcha installer.  curl -fsSL <url>/install.sh | sh
#
# Downloads a tagged release, installs it under ~/.local/share/gotcha/app, and
# symlinks the CLI onto PATH. No sudo, nothing written outside your home.
set -eu

REPO="${GOTCHA_REPO:-RyanSavoia/gotcha-collector}"
VERSION="${GOTCHA_VERSION:-latest}"
PREFIX="${GOTCHA_PREFIX:-$HOME/.local}"
APP_DIR="$PREFIX/share/gotcha/app"
BIN_DIR="$PREFIX/bin"

say() { printf '%s\n' "$*"; }
die() { printf 'gotcha install: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node is required (>= 14). Install node first: https://nodejs.org"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 14 ] || die "node >= 14 required; found $(node -v)"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar  >/dev/null 2>&1 || die "tar is required"

if [ "$VERSION" = "latest" ]; then
  TARBALL="https://api.github.com/repos/$REPO/tarball"
else
  TARBALL="https://api.github.com/repos/$REPO/tarball/$VERSION"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

say "gotcha: downloading $REPO ($VERSION)"
curl -fsSL "$TARBALL" -o "$TMP/gotcha.tar.gz" || die "download failed from $TARBALL"
mkdir -p "$TMP/x"
tar -xzf "$TMP/gotcha.tar.gz" -C "$TMP/x" --strip-components=1 || die "extract failed"
[ -f "$TMP/x/bin/gotcha" ] || die "archive did not contain bin/gotcha"

mkdir -p "$APP_DIR" "$BIN_DIR"
rm -rf "$APP_DIR.old"
[ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.old" 2>/dev/null || true
mkdir -p "$APP_DIR"
cp -R "$TMP/x/." "$APP_DIR/"
rm -rf "$APP_DIR.old"
chmod +x "$APP_DIR/bin/gotcha" 2>/dev/null || true
chmod +x "$APP_DIR"/scripts/*.sh "$APP_DIR"/scripts/*.js 2>/dev/null || true

ln -sf "$APP_DIR/bin/gotcha" "$BIN_DIR/gotcha"
say "gotcha: installed to $APP_DIR"
say "gotcha: linked $BIN_DIR/gotcha"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say ""
     say "  $BIN_DIR is not on your PATH. Add it:"
     say "    echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc && exec zsh" ;;
esac

say ""
say "  Next:  gotcha init        # config, schedules, hooks (about a minute)"
say "         gotcha install .   # point agents in this repo at the fact table"
say "         gotcha doctor      # confirm everything is wired"
