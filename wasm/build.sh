#!/bin/bash
# Builds www/vgap/vendor/mxfdec.{js,wasm} from mxfdec.c.
# Needs emsdk (~/emsdk, 4.0.10) and a libavcodec built for wasm with the mpeg2video decoder.
# By default it links instantclip's build (same FFmpeg 7.1.1 configure, see skill wasm-libavcodec-decoder);
# set FFPREFIX to use another one.
set -e
EMSDK=${EMSDK:-$HOME/emsdk}
FFPREFIX=${FFPREFIX:-$HOME/instantclip/wasm/build/prefix}
CFLAGS="-O3 -msimd128"
cd "$(dirname "$0")"
. "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
OUT=../www/vgap/vendor
mkdir -p $OUT
emcc $CFLAGS mxfdec.c -I"$FFPREFIX/include" -L"$FFPREFIX/lib" -lavcodec -lavutil \
  -o $OUT/mxfdec.js \
  -sMODULARIZE -sEXPORT_NAME=createMxfDec -sENVIRONMENT=worker -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=64MB \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_dec_open,_dec_lowres,_dec_run_packets,_dec_out,_dec_len,_dec_w,_dec_h,_dec_cw,_dec_ch,_dec_close \
  -sEXPORTED_RUNTIME_METHODS=ccall,HEAPU8,HEAP32
ls -l $OUT/mxfdec.*
