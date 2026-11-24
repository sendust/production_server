// WHEP (WebRTC-HTTP egress) receiver for mediamtx: video track only, auto-retry.
export class WhepView {
  constructor(video, { onState } = {}) {
    this.video = video;
    this.onState = onState || (() => {});
    this.pc = null;
    this.url = null;
    this.busy = false;
    this.retryT = null;
  }

  async start(url) {
    if (this.url === url && this.pc && ["connected", "connecting", "new"].includes(this.pc.connectionState)) return;
    this.url = url;
    await this._connect();
  }

  stop() {
    this.url = null;
    clearTimeout(this.retryT);
    this.pc?.close();
    this.pc = null;
    this.video.srcObject = null;
    this.onState("off");
  }

  _retry() {
    clearTimeout(this.retryT);
    if (this.url) this.retryT = setTimeout(() => this._connect(), 2000);
  }

  async _connect() {
    if (this.busy || !this.url) return;
    this.busy = true;
    clearTimeout(this.retryT);
    try {
      this.pc?.close();
      const pc = this.pc = new RTCPeerConnection();
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.ontrack = e => { this.video.srcObject = new MediaStream([e.track]); };
      pc.onconnectionstatechange = () => {
        if (pc !== this.pc) return;
        this.onState(pc.connectionState);
        if (["failed", "disconnected", "closed"].includes(pc.connectionState)) this._retry();
      };
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise(res => {   // non-trickle: send the offer with every candidate
        if (pc.iceGatheringState === "complete") return res();
        pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && res();
        setTimeout(res, 1500);
      });
      const r = await fetch(this.url, { method: "POST", headers: { "Content-Type": "application/sdp" }, body: pc.localDescription.sdp });
      if (!r.ok) throw new Error(`WHEP ${r.status}`);
      await pc.setRemoteDescription({ type: "answer", sdp: await r.text() });
    } catch (e) {
      this.onState(`error: ${e.message}`);
      this._retry();
    } finally { this.busy = false; }
  }

  async stats() {
    if (!this.pc) return null;
    let out = null;
    (await this.pc.getStats()).forEach(r => {
      if (r.type === "inbound-rtp" && r.kind === "video") out = r;
    });
    return out;
  }
}
