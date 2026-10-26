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
# Tauri rejects icons that are not RGBA. PNG32 alone still quantizes a flat
# 16px tile down to a palette, so color type 6 forces truecolor alpha.
dock_png() {
  local size=$1 out=$2
  magick "$work/dock.png" -filter Lanczos -resize "$size" -strip \
    -define png:color-type=6 "PNG32:$out"
}

dock_png 16x16 "$icons/16x16.png"
dock_png 32x32 "$icons/32x32.png"
dock_png 128x128 "$icons/128x128.png"
dock_png 256x256 "$icons/128x128@2x.png"
dock_png 256x256 "$icons/256x256.png"
dock_png 1024x1024 "$icons/icon.png"

iconset=$work/icon.iconset
mkdir -p "$iconset"
dock_png 16x16 "$iconset/icon_16x16.png"
dock_png 32x32 "$iconset/icon_16x16@2x.png"
dock_png 32x32 "$iconset/icon_32x32.png"
dock_png 64x64 "$iconset/icon_32x32@2x.png"
dock_png 128x128 "$iconset/icon_128x128.png"
dock_png 256x256 "$iconset/icon_128x128@2x.png"
dock_png 256x256 "$iconset/icon_256x256.png"
dock_png 512x512 "$iconset/icon_256x256@2x.png"
dock_png 512x512 "$iconset/icon_512x512.png"
dock_png 1024x1024 "$iconset/icon_512x512@2x.png"
iconutil -c icns "$iconset" -o "$icons/icon.icns"

magick "$work/dock.png" -filter Lanczos \
  -define icon:auto-resize=256,64,48,32,16 \
  "$icons/icon.ico"

magick identify "$icons/icon.png" "$public/logo-light.png" "$public/logo-dark.png" \
  "$public/favicon-light.png" "$public/favicon-dark.png"
