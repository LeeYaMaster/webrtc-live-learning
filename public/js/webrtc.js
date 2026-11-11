/**
 * WebRTC 核心封装 —— 学习时请重点看这个文件。
 *
 * 一条 RTCPeerConnection 只连接「主播 ↔ 一位观众」。
 * 主播要对每位观众各建一条，这就是本项目采用的 fan-out（分发）模型。
 *
 * 标准握手顺序（本项目始终由主播发起 Offer）：
 *  1. 双方 new RTCPeerConnection
 *  2. 主播 addTrack（把本地摄像头/麦克风轨加进去）
 *  3. 主播 createOffer() → setLocalDescription(offer) → 经信令把 SDP 发给观众
 *  4. 观众 setRemoteDescription(offer) → createAnswer() → setLocalDescription(answer) → 发回主播
 *  5. 主播 setRemoteDescription(answer)
 *  6. 双方在 onicecandidate 里把 ICE 候选交给对方；对方 addIceCandidate
 *  7. 观众在 ontrack 里拿到 MediaStream，挂到 <video> 上播放
 */

// 仅 STUN。localhost 同机多标签页其实不需要，加上是为了局域网探究时能发现候选。
// 跨网关 / 4G 互访通常还要 TURN，本项目不强制配置。
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

export function createPeer({
  remoteId,
  label,
  onIceCandidate,
  onTrack,
  onState,
  onLocalSdp,
} = {}) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // ICE 候选可能在 setRemoteDescription 之前就到达，必须先排队，否则会抛错或被丢弃。
  const pendingCandidates = [];
  let remoteReady = false;

  pc.onicecandidate = (ev) => {
    // ev.candidate 为 null 表示这一侧 ICE 收集结束（仍要通知 UI，不必转发给对方）。
    onIceCandidate?.(ev.candidate, ev);
  };

  pc.ontrack = (ev) => {
    onTrack?.(ev);
  };

  const notify = (kind, value) => {
    onState?.({ kind, value, pc, remoteId, label });
  };

  pc.onsignalingstatechange = () => notify('signaling', pc.signalingState);
  pc.oniceconnectionstatechange = () => notify('iceConnection', pc.iceConnectionState);
  pc.onicegatheringstatechange = () => notify('iceGathering', pc.iceGatheringState);
  pc.onconnectionstatechange = () => notify('connection', pc.connectionState);

  async function flushCandidates() {
    while (pendingCandidates.length) {
      const candidate = pendingCandidates.shift();
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn('addIceCandidate 失败', err);
      }
    }
  }

  return {
    pc,
    remoteId,
    label,

    /**
     * 主播侧：把本地音视频轨加到这条连接上。
     * addTrack 之后浏览器通常会触发协商；我们选择自己调用 createOffer，流程更直观。
     */
    attachLocalStream(stream) {
      if (!stream) return;
      const existing = new Set(pc.getSenders().map((s) => s.track).filter(Boolean));
      for (const track of stream.getTracks()) {
        if (!existing.has(track)) pc.addTrack(track, stream);
      }
    },

    /** 主播：创建 Offer，并设为本地描述。 */
    async createAndSendOffer() {
      const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(offer);
      onLocalSdp?.(pc.localDescription);
      return pc.localDescription;
    },

    /** 观众：收下 Offer，创建 Answer。 */
    async acceptOfferAndCreateAnswer(sdp) {
      await this.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      onLocalSdp?.(pc.localDescription);
      return pc.localDescription;
    },

    /** 主播：收下 Answer。 */
    async acceptAnswer(sdp) {
      await this.setRemoteDescription(sdp);
    },

    async setRemoteDescription(sdp) {
      await pc.setRemoteDescription(sdp);
      remoteReady = true;
      await flushCandidates();
    },

    async addIceCandidate(candidate) {
      if (!candidate) return;
      if (!remoteReady) {
        pendingCandidates.push(candidate);
        return;
      }
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn('addIceCandidate 失败', err);
      }
    },

    /**
     * 屏幕共享 / 切回摄像头：优先用 replaceTrack，不必重新走 offer/answer。
     * 如果当初是「仅音频」开播、还没有 video sender，则 addTrack 并告诉调用方需要重新协商。
     */
    async replaceVideoTrack(track) {
      const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video')
        || pc.getTransceivers().find((t) => t.sender?.track?.kind === 'video')?.sender;
      if (videoSender) {
        await videoSender.replaceTrack(track);
        return { renegotiate: false };
      }
      if (track) {
        pc.addTrack(track);
        return { renegotiate: true };
      }
      return { renegotiate: false };
    },

    close() {
      try {
        pc.getSenders().forEach((s) => {
          // 不在这里 stop 本地轨：同一条本地轨会共享给多条连接。
        });
        pc.close();
      } catch {
        // ignore
      }
    },
  };
}

export async function getCameraStream() {
  const videoConstraints = {
    audio: { echoCancellation: true, noiseSuppression: true },
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: 'user',
    },
  };
  try {
    return { stream: await navigator.mediaDevices.getUserMedia(videoConstraints), audioOnly: false };
  } catch (err) {
    // 没有摄像头或被拒绝视频时，退回仅音频，方便在无摄像头环境里走完信令流程。
    if (err && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError' || err.name === 'NotReadableError')) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      return { stream, audioOnly: true };
    }
    throw err;
  }
}

export async function getScreenStream() {
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 15 }, cursor: 'always' },
    audio: false,
  });
}

/** 停掉一条流里的全部轨道，释放设备。 */
export function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { /* ignore */ }
  }
}
