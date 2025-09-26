#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "${SCRIPT_DIR}/.." && pwd)

XML_FILE="${REPO_ROOT}/xml/document.xml"
XSL_FILE="${REPO_ROOT}/xslt/xml2tex.xsl"
BUILD_DIR="${REPO_ROOT}/build"
TEX_DIR="${REPO_ROOT}/tex"
BODY_TEX="${BUILD_DIR}/body.tex"

mkdir -p "${BUILD_DIR}"

echo "[pipeline] Transforming XML -> LaTeX"
xsltproc "${XSL_FILE}" "${XML_FILE}" > "${BODY_TEX}"

echo "[pipeline] Running LuaLaTeX"
(
  cd "${TEX_DIR}"
  lualatex -interaction=nonstopmode -output-directory="${BUILD_DIR}" master.tex
)

echo "[pipeline] Calculating incremental changes"
python3 "${REPO_ROOT}/tools/incremental.py"

echo "[pipeline] Done"
