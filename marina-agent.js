/* ===============================================================
   MARINA-GRADE SITE AGENT v1 (BlueColumn AI)
   Parity with the Marina v14 reference stack:
   - LIVE BRAIN: BlueColumn /recall answers any customer question in
     real time (query prefixed with the business name).
   - DYNAMIC TTS: ElevenLabs flash v2_5 speaks every reply; per-site
     premade voice so each business sounds distinct.
   - SIMLI VIDEO: real-time talking head (person avatar), replies
     streamed as PCM16/16kHz into the WebRTC session.
   - ONE VOICE AT A TIME: newest speech cancels the active feed
     (simliFeed guard). TTS failure never overlaps the avatar voice —
     the reply stays as on-screen text.
   - CANNED INTENTS = offline fallback ONLY (brain answer wins unless
     it is empty / "not in available context").
   Site-specific behavior (name, face, voice, intents, booking flow)
   comes from window.BOT_CFG defined in each site's index.html.
   =============================================================== */
(function () {
  'use strict';

  var CFG = window.BOT_CFG;
  if (!CFG) { return; }

  var BRAIN_URL = 'https://xkjkwqbfvkswwdmbtndo.supabase.co/functions/v1/recall';
  var BRAIN_KEY = 'bc_live_p3NlMdAVuCXATRiffBsQLDTRy6p_cUPy';
  var TTS_KEY = 'sk_6b9aa7c4edd19c804554e48fd48dac0dc3686a3fb49cc843';
  var SIMLI_API_KEY = '5e2ucmvyrlmkapwg4hzyf';

  /* -- Elements (each site keeps its existing bot DOM ids) ----- */
  function F(id) { return document.getElementById(id); }
  var fab = F('bot-fab'), panel = F('bot-panel'), log = F('bot-log'), input = F('bot-in');
  var muteBtn = F('bot-mute'), micBtn = F('bot-mic'), videoBtn = F('bot-video');
  var videoEl = F('bot-video-el'), simliAudio = F('bot-simli-audio'), avatarEl = F('bot-avatar');
  if (!fab || !panel || !log || !input) { return; }

  /* -- State --------------------------------------------------- */
  var muted = false, started = false, speaking = false, speechEndCb = null;
  var currentAudio = null, mouthRAF = null, audioCtx = null, analyser = null, mouthData = null;
  var videoMode = { on: false }, videoStarting = false, simliClient = null, simliFeed = null;
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recog = null, micOn = false, micWanted = false;
  var supported = !!SR;

  /* -- Message helpers ----------------------------------------- */
  function addMsg(t, cls) {
    var d = document.createElement('div');
    d.className = cls;
    d.textContent = t;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }
  function botSay(t) { return addMsg(t, 'msg bot'); }
  function userSay(t) { return addMsg(t, 'msg user'); }
  function typing() {
    var d = document.createElement('div');
    d.className = 'msg bot bc-typing';
    d.setAttribute('aria-label', CFG.name + ' is thinking');
    d.innerHTML = '<span></span><span></span><span></span>';
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }
  function opts(arr) {
    var w = document.createElement('div');
    w.className = 'bot-opts';
    arr.forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = a;
      b.onclick = function () { send(a); };
      w.appendChild(b);
    });
    log.appendChild(w);
    log.scrollTop = log.scrollHeight;
  }

  /* -- Mouth animation (squish on the emoji avatar) ------------ */
  function stopMouth() {
    if (mouthRAF) { cancelAnimationFrame(mouthRAF); mouthRAF = null; }
    if (avatarEl) { avatarEl.style.transform = ''; avatarEl.classList.remove('talking'); }
  }
  function startMouth() {
    if (!currentAudio || !avatarEl) { return; }
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (!analyser) {
        var src = audioCtx.createMediaElementSource(currentAudio);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        analyser.connect(audioCtx.destination);
        mouthData = new Uint8Array(analyser.frequencyBinCount);
      }
    } catch (e) { /* analyser unavailable: CSS rhythm still applies */ }
    var tick = function () {
      if (!currentAudio || currentAudio.paused) { stopMouth(); return; }
      var energy = 0.5 + 0.5 * Math.sin(Date.now() / 80);
      if (analyser && mouthData) {
        analyser.getByteFrequencyData(mouthData);
        var sum = 0, i;
        for (i = 2; i < 40; i++) { sum += mouthData[i]; }
        energy = sum / 38 / 255;
      }
      var sy = 1 + energy * 0.18, sx = 1 - energy * 0.12;
      avatarEl.style.transform = 'scaleY(' + sy.toFixed(3) + ') scaleX(' + sx.toFixed(3) + ')';
      mouthRAF = requestAnimationFrame(tick);
    };
    mouthRAF = requestAnimationFrame(tick);
  }
  function botFinished() {
    speaking = false;
    stopMouth();
    var cb = speechEndCb; speechEndCb = null;
    if (cb) { cb(); }
    if (micWanted) { setTimeout(pauseListeningThenResume, 350); }
  }
  function cancelSpeech() {
    /* ONE VOICE: newest user message always wins */
    try { if (currentAudio) { currentAudio.pause(); } } catch (e) {}
    if (simliFeed) { clearInterval(simliFeed.iv); simliFeed = null; }
    stopMouth();
    speaking = false; speechEndCb = null;
  }

  /* ============================================================
     LIVE BRAIN (BlueColumn /recall) — canned intents = fallback
     ============================================================ */
  function matchIntent(text) {
    var low = text.toLowerCase();
    for (var i = 0; i < CFG.intents.length; i++) {
      var it = CFG.intents[i];
      for (var j = 0; j < it.k.length; j++) {
        if (low.indexOf(it.k[j]) !== -1) { return it; }
      }
    }
    return null;
  }
  function askBrain(text) {
    var canned = matchIntent(text);
    var cannedText = canned ? canned.t : CFG.fallback;
    return fetch(BRAIN_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + BRAIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: CFG.brainPrefix + text })
    }).then(function (res) { return res.json(); }).then(function (d) {
      var a = (d && d.answer ? String(d.answer) : '').trim();
      if (!a || /not in available context/i.test(a) || a.length < 8) {
        return { t: cannedText, canned: true };
      }
      return { t: a, canned: false };
    }).catch(function () { return { t: cannedText, canned: true }; });
  }

  /* ============================================================
     DYNAMIC TTS + ONE-VOICE VIDEO STREAMING (Marina v14 rules)
     ============================================================ */
  function ttsFetch(text) {
    return fetch('https://api.elevenlabs.io/v1/text-to-speech/' + CFG.voiceId + '?output_format=mp3_44100_128', {
      method: 'POST',
      headers: { 'xi-api-key': TTS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, model_id: 'eleven_flash_v2_5' })
    }).then(function (res) {
      if (!res.ok) { throw new Error('tts ' + res.status); }
      return res.blob();
    });
  }

  function simliReady() { return !!(simliClient && videoMode.on); }

  async function simliStream(ab) {
    try {
      if (simliFeed) { clearInterval(simliFeed.iv); simliFeed = null; }
      try { if (currentAudio) { currentAudio.pause(); } } catch (eA) {}
      var decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
      var decoded = await decodeCtx.decodeAudioData(ab);
      if (decodeCtx.close) { decodeCtx.close(); }
      var durMs = decoded.duration * 1000;
      var len = Math.max(1, Math.ceil(decoded.duration * 16000));
      var off = new OfflineAudioContext(1, len, 16000);
      var src = off.createBufferSource();
      src.buffer = decoded;
      src.connect(off.destination);
      src.start();
      var rendered = await off.startRendering();
      var ch = rendered.getChannelData(0);
      var pcm = new Int16Array(ch.length);
      for (var i = 0; i < ch.length; i++) {
        var v = Math.max(-1, Math.min(1, ch[i]));
        pcm[i] = v < 0 ? v * 32768 : v * 32767;
      }
      var bytes = new Uint8Array(pcm.buffer);
      var CHUNK = 6000, pos = 0;
      var feed = { iv: null };
      simliFeed = feed;
      var iv = setInterval(function () {
        if (simliFeed !== feed) { clearInterval(iv); return; } /* superseded by newer speech */
        if (!simliReady()) { clearInterval(iv); if (simliFeed === feed) { simliFeed = null; } botFinished(); return; }
        if (pos >= bytes.length) { clearInterval(iv); if (simliFeed === feed) { simliFeed = null; } return; }
        var end = Math.min(pos + CHUNK, bytes.length);
        try { simliClient.sendAudioData(bytes.slice(pos, end)); } catch (e) { clearInterval(iv); if (simliFeed === feed) { simliFeed = null; } botFinished(); }
        pos = end;
      }, 175);
      feed.iv = iv;
      setTimeout(function () { if (speaking && simliFeed === feed) { botFinished(); } }, durMs + 900);
    } catch (e) { botFinished(); }
  }

  function speakTextThroughSimli(text) {
    ttsFetch(text).then(function (blob) { return blob.arrayBuffer(); })
      .then(function (ab) { return simliStream(ab); })
      .catch(function () { botFinished(); /* v14: never overlap the avatar voice */ });
  }

  function playReply(r) {
    if (muted || videoStarting) { setTimeout(botFinished, 300); return; }
    if (videoMode.on && simliReady()) { speakTextThroughSimli(r.t); return; }
    ttsFetch(r.t).then(function (blob) {
      stopMouth();
      try { if (currentAudio) { currentAudio.pause(); } } catch (e2) {}
      currentAudio = new Audio(URL.createObjectURL(blob));
      if (avatarEl) { avatarEl.classList.add('talking'); }
      currentAudio.onended = botFinished;
      currentAudio.play().then(startMouth).catch(function () { botFinished(); });
    }).catch(function () {
      if (videoMode.on && simliReady()) { botFinished(); return; } /* never overlap the avatar */
      botFinished(); /* TTS unavailable: reply stays as text, voice stays silent */
    });
  }

  /* ============================================================
     SIMLI VIDEO (person avatar, real-time WebRTC)
     ============================================================ */
  async function startSimli() {
    var res = await fetch('https://api.simli.ai/startAudioToVideoSession', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: SIMLI_API_KEY,
        faceId: CFG.faceId,
        handleSilence: true,
        maxSessionLength: 600,
        maxIdleTime: 180
      })
    });
    if (!res.ok) { throw new Error('Simli token ' + res.status); }
    var data = await res.json();
    var ice = null;
    try { ice = await SimliLib.generateIceServers(SIMLI_API_KEY); } catch (e) {}
    function makeClient(transport) {
      return new SimliLib.SimliClient(
        data.session_token, videoEl, simliAudio, ice,
        SimliLib.LogLevel ? SimliLib.LogLevel.WARN : undefined, transport
      );
    }
    try {
      simliClient = makeClient('livekit');
      await simliClient.start();
    } catch (e1) {
      try { if (simliClient && simliClient.stop) { simliClient.stop(); } } catch (e) {}
      try { if (simliClient && simliClient.close) { simliClient.close(); } } catch (e) {}
      simliClient = makeClient('p2p');
      await simliClient.start();
    }
    try { await videoEl.play(); } catch (e) {}
    try { await simliAudio.play(); } catch (e) {}
  }

  function inAppBrowser() {
    var ua = navigator.userAgent || '';
    return /FBAN|FBAV|FB_IAB|Instagram|Line\/|Snapchat|TikTok/i.test(ua);
  }

  async function toggleVideo() {
    if (videoMode.on) {
      videoMode.on = false;
      panel.classList.remove('video-mode');
      videoBtn.classList.remove('on');
      try { if (simliClient && simliClient.close) { simliClient.close(); } } catch (e) {}
      simliClient = null;
      botSay('Switched back to voice mode.');
      return;
    }
    if (inAppBrowser()) {
      botSay('This in-app browser blocks live video. Open this page in Safari (or Chrome) and the talking avatar will work.');
      return;
    }
    if (!window.RTCPeerConnection) {
      botSay('This browser does not support live video (WebRTC). Voice mode still works — or open the page in Safari.');
      return;
    }
    if (!window.SimliLib) {
      botSay('Video avatar library did not load — voice mode still works.');
      return;
    }
    videoBtn.textContent = '…';
    videoStarting = true;
    cancelSpeech();
    try {
      await startSimli();
      videoMode.on = true;
      videoStarting = false;
      panel.classList.add('video-mode');
      videoBtn.classList.add('on');
      videoBtn.textContent = '🎥';
      botSay('Video avatar is live now — watch me talk. Tap the mic and just talk to me.');
      setModeUI();
    } catch (e) {
      videoStarting = false;
      videoBtn.textContent = '🎥';
      var why = (e && (e.message || e.reason || e)) ? String(e.message || e.reason || e) : 'unknown';
      botSay('Video could not connect (' + why + '). Voice mode still works. If you keep seeing this, open the page in Safari.');
    }
  }

  /* ============================================================
     HANDS-FREE VOICE (Web Speech API)
     ============================================================ */
  function buildRecognizer() {
    var r = new SR();
    r.lang = 'en-US';
    r.continuous = false;
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onresult = function (ev) {
      var t = ev.results[0][0].transcript.trim();
      if (t) { send(t); }
    };
    r.onerror = function (ev) {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        micWanted = false; setMicUI(false);
        botSay('Microphone access is blocked — enable it in your browser settings to talk hands-free.');
      }
    };
    r.onend = function () {
      setMicUI(micWanted);
      if (micWanted && !speaking) {
        setTimeout(function () { try { recog.start(); } catch (e) {} }, 300);
      }
    };
    return r;
  }
  function pauseListeningThenResume() {
    if (!micWanted) { return; }
    setTimeout(function () {
      if (micWanted && !speaking) { try { recog && recog.start(); } catch (e) {} }
    }, 250);
  }
  function setMicUI(on) {
    if (micBtn) { micBtn.classList.toggle('on', on); }
    input.placeholder = on ? 'Listening... just talk' : (CFG.placeholder || 'Ask a question…');
    setModeUI();
  }
  function toggleMic() {
    if (!supported) {
      botSay(inAppBrowser()
        ? 'Voice input is blocked in this in-app browser — open the page in Safari and the mic will work.'
        : 'Voice input needs Chrome, Edge, or Safari 14.5+. Typing works everywhere.');
      return;
    }
    micWanted = !micWanted;
    micOn = micWanted;
    if (micWanted) {
      if (muted) { toggleMute(); }
      recog = recog || buildRecognizer();
      try { recog.start(); setMicUI(true); } catch (e) { /* already started */ }
    } else {
      try { recog && recog.stop(); } catch (e) {}
      setMicUI(false);
    }
  }
  function toggleMute() {
    muted = !muted;
    if (muteBtn) {
      muteBtn.textContent = muted ? '🔇' : '🔊';
      muteBtn.title = muted ? 'Voice off' : 'Voice on';
    }
    if (muted && currentAudio) { currentAudio.pause(); }
  }
  function setModeUI() {
    if (micBtn) { micBtn.classList.toggle('on', micWanted || videoMode.on); }
    if (videoBtn) { videoBtn.classList.toggle('on', videoMode.on || videoStarting); }
  }

  /* ============================================================
     CONVERSATION FLOW — site flow hook first, then live brain
     ============================================================ */
  function send(txt) {
    txt = (txt || input.value).trim();
    if (!txt) { return; }
    cancelSpeech(); /* one voice at a time: new speech cancels the active feed */
    userSay(txt);
    input.value = '';
    var t = typing();
    function deliver(r) {
      if (t.parentNode) { t.parentNode.removeChild(t); }
      botSay(r.t);
      if (r.opts && r.opts.length) { opts(r.opts); }
      speaking = true;
      playReply(r);
    }
    /* site-specific canned flow (e.g. StarBot booking) wins — it is a
       guided intent, not a knowledge question */
    var flowed = null;
    try { flowed = CFG.pre ? CFG.pre(txt) : null; } catch (eP) { flowed = null; }
    if (flowed && flowed.t) {
      setTimeout(function () { deliver(flowed); }, 420);
      return;
    }
    askBrain(txt).then(deliver);
  }

  /* -- Panel open/close ---------------------------------------- */
  function openPanel() {
    panel.classList.add('open');
    fab.setAttribute('aria-expanded', 'true');
    if (!started) {
      started = true;
      botSay(CFG.greeting);
      if (CFG.suggestions && CFG.suggestions.length) { opts(CFG.suggestions); }
    }
    setModeUI();
    input.focus();
  }
  function closePanel() {
    panel.classList.remove('open');
    fab.setAttribute('aria-expanded', 'false');
    if (micWanted) { toggleMic(); }
    if (videoMode.on) { toggleVideo(); }
  }

  /* -- Wire up -------------------------------------------------- */
  fab.addEventListener('click', function () {
    if (panel.classList.contains('open')) { closePanel(); } else { openPanel(); }
  });
  if (muteBtn) { muteBtn.addEventListener('click', toggleMute); }
  if (micBtn) { micBtn.addEventListener('click', toggleMic); }
  if (videoBtn) { videoBtn.addEventListener('click', toggleVideo); }
  var sendBtn = F('bot-send');
  if (sendBtn) { sendBtn.addEventListener('click', function () { send(); }); }
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { send(); } });

  /* Expose for legacy inline onclicks (botSend/toggleBot) if any remain */
  window.botSend = function (t) { send(t); };
  window.toggleBot = openPanel;
})();
