/* MXF essence decoder for www/vgap/decoder-worker.js: libavcodec behind a few calls, built by build.sh.
 *
 *   Dec *d = dec_open("mpeg2video", lowres);
 *   int n  = dec_run_packets(d, data, sizes, count, max);  // `count` frame-wrapped pictures laid end to end
 *   dec_out(d), dec_len(d), dec_w(d), dec_h(d), dec_cw(d), dec_ch(d)   // valid until the next run
 *
 * MXF is frame wrapped: one picture KLV = one packet, so no parser is needed (and none of its one-frame delay).
 * Output: up to `max` frames in display order, packed planar (Y w*h, then U and V cw*ch each), 8 bit.
 * The decoder context is opened once and reused (flushed per run): no per-GOP allocation or leak, unlike
 * running the ffmpeg CLI core repeatedly (see skill wasm-libavcodec-decoder).
 */
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>
#include <libavcodec/avcodec.h>
#include <libavutil/pixdesc.h>

typedef struct {
  AVCodecContext *c;
  AVPacket *pkt;
  AVFrame *f;
  uint8_t *out;
  size_t cap, len;
  int count, max, w, h, cw, ch;
} Dec;

static int grow(Dec *d, size_t need) {
  if (d->len + need <= d->cap) return 0;
  size_t cap = d->cap ? d->cap : 1 << 22;
  while (cap < d->len + need) cap *= 2;
  uint8_t *o = realloc(d->out, cap);
  if (!o) return AVERROR(ENOMEM);
  d->out = o;
  d->cap = cap;
  return 0;
}

static int take_video(Dec *d, const AVFrame *f) {
  if (d->count >= d->max) return 0;
  const AVPixFmtDescriptor *pd = av_pix_fmt_desc_get(f->format);
  if (!pd || (pd->flags & AV_PIX_FMT_FLAG_RGB) || pd->nb_components < 3 || pd->comp[0].depth > 8)
    return AVERROR_PATCHWELCOME;
  int w = f->width, h = f->height;
  int cw = AV_CEIL_RSHIFT(w, pd->log2_chroma_w), ch = AV_CEIL_RSHIFT(h, pd->log2_chroma_h);
  if (d->count && (w != d->w || h != d->h || cw != d->cw || ch != d->ch)) return 0;
  int r = grow(d, (size_t)w * h + 2 * (size_t)cw * ch);
  if (r < 0) return r;
  for (int i = 0; i < 3; i++) {
    int pw = i ? cw : w, ph = i ? ch : h;
    for (int y = 0; y < ph; y++, d->len += pw) memcpy(d->out + d->len, f->data[i] + (size_t)y * f->linesize[i], pw);
  }
  d->w = w; d->h = h; d->cw = cw; d->ch = ch;
  d->count++;
  return 0;
}

static int drain(Dec *d) {
  int r, bad = 0;
  while ((r = avcodec_receive_frame(d->c, d->f)) >= 0 ||
         (r != AVERROR(EAGAIN) && r != AVERROR_EOF && r != AVERROR(ENOMEM) && ++bad < 1000)) {
    if (r < 0) continue;
    r = take_video(d, d->f);
    av_frame_unref(d->f);
    if (r < 0) return r;
  }
  return r == AVERROR(EAGAIN) || r == AVERROR_EOF ? 0 : r;
}

static int send(Dec *d, uint8_t *data, int size) {
  int r;
  d->pkt->data = data;
  d->pkt->size = size;
  while ((r = avcodec_send_packet(d->c, data ? d->pkt : NULL)) == AVERROR(EAGAIN))
    if ((r = drain(d)) < 0) return r;
  if (r == AVERROR(ENOMEM)) return r;
  return drain(d);   // AVERROR_INVALIDDATA etc: skip the packet, like ffmpeg does
}

EMSCRIPTEN_KEEPALIVE Dec *dec_open(const char *name, int lowres) {
  av_log_set_level(AV_LOG_QUIET);
  const AVCodec *codec = avcodec_find_decoder_by_name(name);
  if (!codec || codec->type != AVMEDIA_TYPE_VIDEO) return NULL;
  Dec *d = calloc(1, sizeof *d);
  d->c = avcodec_alloc_context3(codec);
  d->pkt = av_packet_alloc();
  d->f = av_frame_alloc();
  if (!d->c || !d->pkt || !d->f) goto fail;
  d->c->lowres = lowres < 0 ? 0 : lowres > codec->max_lowres ? codec->max_lowres : lowres;
  d->c->thread_count = 1;
  if (avcodec_open2(d->c, codec, NULL) < 0) goto fail;
  return d;
fail:
  avcodec_free_context(&d->c);
  av_packet_free(&d->pkt);
  av_frame_free(&d->f);
  free(d);
  return NULL;
}

EMSCRIPTEN_KEEPALIVE int dec_lowres(Dec *d) { return d->c->lowres; }

EMSCRIPTEN_KEEPALIVE int dec_run_packets(Dec *d, uint8_t *data, int32_t *sizes, int count, int max) {
  avcodec_flush_buffers(d->c);
  d->len = 0;
  d->count = 0;
  d->max = max > 0 ? max : INT_MAX;
  int r;
  for (int i = 0; i < count; i++) {
    if (sizes[i] > 0 && (r = send(d, data, sizes[i])) < 0) return r;
    data += sizes[i];
    if (d->count >= d->max) return d->count;
  }
  if ((r = send(d, NULL, 0)) < 0) return r;
  return d->count;
}

EMSCRIPTEN_KEEPALIVE uint8_t *dec_out(Dec *d) { return d->out; }
EMSCRIPTEN_KEEPALIVE int dec_len(Dec *d) { return (int)d->len; }
EMSCRIPTEN_KEEPALIVE int dec_w(Dec *d) { return d->w; }
EMSCRIPTEN_KEEPALIVE int dec_h(Dec *d) { return d->h; }
EMSCRIPTEN_KEEPALIVE int dec_cw(Dec *d) { return d->cw; }
EMSCRIPTEN_KEEPALIVE int dec_ch(Dec *d) { return d->ch; }

EMSCRIPTEN_KEEPALIVE void dec_close(Dec *d) {
  if (!d) return;
  avcodec_free_context(&d->c);
  av_packet_free(&d->pkt);
  av_frame_free(&d->f);
  free(d->out);
  free(d);
}
