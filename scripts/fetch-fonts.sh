#!/usr/bin/env bash
# Noto fonts (SIL OFL 1.1) for substitution and embedding. TrueType outlines only (PDF FontFile2).
set -euo pipefail
cd "$(dirname "$0")/../fonts"
get() { [ -s "$1" ] || curl -fsSL -o "$1" "$2"; }
get NotoSans-Regular.ttf https://github.com/notofonts/notofonts.github.io/raw/main/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf
get NotoSans-Bold.ttf    https://github.com/notofonts/notofonts.github.io/raw/main/fonts/NotoSans/hinted/ttf/NotoSans-Bold.ttf
get NotoSansJP-VF.ttf    https://github.com/notofonts/noto-cjk/raw/main/Sans/Variable/TTF/Subset/NotoSansJP-VF.ttf
get OFL.txt              https://github.com/notofonts/noto-cjk/raw/main/Sans/LICENSE
sha256sum ./*.ttf > SHA256SUMS.local
ls -la
