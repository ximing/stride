#!/usr/bin/env bash
# Build Stride icons from the transparent logo at the repo root.
#
# Dock / bundle icon is a full-bleed white square. macOS and Windows 11 mask
# that square into a rounded tile; transparent corners outside a pre-rounded
# plate show up black in the Dock. The ribbon is 72% of the canvas height so
# the mark stays clear of the squircle without looking lost in the padding.
#
# Web and in-app marks are rounded tiles: white for light, elevated dark for
# dark. The ribbon there is 80% of the tile so a 16px favicon still reads.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
src=${1:-"$root/logo.png"}
icons="$root/apps/desktop/src-tauri/icons"
public="$root/apps/desktop/public"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [[ ! -f "$src" ]]; then
  echo "missing logo: $src" >&2
  exit 1
fi

mkdir -p "$icons" "$public"

# Drop near-invisible dust, then trim to the opaque ribbon.
magick "$src" -alpha set -channel A -threshold 5% +channel -trim +repage -strip \
  "$work/mark.png"

# Dock master: 1024 white, ribbon height = 72% of the canvas (738px).
magick "$work/mark.png" -filter Lanczos -resize x738 \
  "$work/glyph.png"
magick -size 1024x1024 xc:'#ffffff' \
  "$work/glyph.png" -gravity center -compose over -composite -strip \
  "$work/dock.png"

# Theme tiles. Corner radius is 22% of the side, the same proportion as the
# current macOS squircle. Ribbon height is 80% of the tile.
tile() {
  local fill=$1 out=$2 size=$3
  local radius=$((size * 22 / 100))
  local glyph=$((size * 80 / 100))
  local edge=$((size - 1))
  magick "$work/mark.png" -filter Lanczos -resize "x${glyph}" "$work/tile-glyph.png"
  magick -size "${size}x${size}" xc:none \
    -fill "$fill" -draw "roundrectangle 0,0 ${edge},${edge} ${radius},${radius}" \
    "$work/tile-glyph.png" -gravity center -compose over -composite -strip \
    "PNG32:$out"
}

tile '#ffffff' "$work/logo-light.png" 256
tile '#272c28' "$work/logo-dark.png" 256

cp "$work/logo-light.png" "$public/logo-light.png"
cp "$work/logo-dark.png" "$public/logo-dark.png"
magick "$work/logo-light.png" -filter Lanczos -resize 64x64 -strip "PNG32:$public/favicon-light.png"
magick "$work/logo-dark.png" -filter Lanczos -resize 64x64 -strip "PNG32:$public/favicon-dark.png"

# Bundle sizes named the way tauri.conf.json expects them.
magick "$work/dock.png" -filter Lanczos -resize 16x16 -strip "$icons/16x16.png"
magick "$work/dock.png" -filter Lanczos -resize 32x32 -strip "$icons/32x32.png"
magick "$work/dock.png" -filter Lanczos -resize 128x128 -strip "$icons/128x128.png"
magick "$work/dock.png" -filter Lanczos -resize 256x256 -strip "$icons/128x128@2x.png"
magick "$work/dock.png" -filter Lanczos -resize 256x256 -strip "$icons/256x256.png"
magick "$work/dock.png" -strip "PNG32:$icons/icon.png"

iconset=$work/icon.iconset
mkdir -p "$iconset"
magick "$work/dock.png" -filter Lanczos -resize 16x16 -strip "$iconset/icon_16x16.png"
magick "$work/dock.png" -filter Lanczos -resize 32x32 -strip "$iconset/icon_16x16@2x.png"
magick "$work/dock.png" -filter Lanczos -resize 32x32 -strip "$iconset/icon_32x32.png"
magick "$work/dock.png" -filter Lanczos -resize 64x64 -strip "$iconset/icon_32x32@2x.png"
magick "$work/dock.png" -filter Lanczos -resize 128x128 -strip "$iconset/icon_128x128.png"
magick "$work/dock.png" -filter Lanczos -resize 256x256 -strip "$iconset/icon_128x128@2x.png"
magick "$work/dock.png" -filter Lanczos -resize 256x256 -strip "$iconset/icon_256x256.png"
magick "$work/dock.png" -filter Lanczos -resize 512x512 -strip "$iconset/icon_256x256@2x.png"
magick "$work/dock.png" -filter Lanczos -resize 512x512 -strip "$iconset/icon_512x512.png"
magick "$work/dock.png" -filter Lanczos -resize 1024x1024 -strip "$iconset/icon_512x512@2x.png"
iconutil -c icns "$iconset" -o "$icons/icon.icns"

magick "$work/dock.png" -filter Lanczos \
  -define icon:auto-resize=256,64,48,32,16 \
  "$icons/icon.ico"

magick identify "$icons/icon.png" "$public/logo-light.png" "$public/logo-dark.png" \
  "$public/favicon-light.png" "$public/favicon-dark.png"
