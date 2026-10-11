// One chat field for typed messages and speech, with directly accessible media controls.
export function createComposer({ question, send, mic, activity, status, confirmation, countdown, cancel,
  settings, settingsToggle, settingsClose, onAsk, onMic,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
  let timer = null;
  function resize() {
    question.style.height = 'auto';
    question.style.height = Math.min(112, Math.max(56, question.scrollHeight || 56)) + 'px';
  }
  function setMicStatus(text) {
    status.textContent = text;
    activity.hidden = !text;
  }
  function cancelCountdown() {
    if (timer !== null) clearIntervalImpl(timer);
    timer = null;
    confirmation.hidden = true;
    countdown.textContent = '';
  }
  function submit() {
    if (send.disabled) return;
    const text = (question.value || '').trim();
    if (!text) return;
    cancelCountdown();
    setMicStatus('');
    onAsk(text);
  }
  function showTranscript(text) {
    cancelCountdown();
    question.value = text;
    resize();
    question.focus();
    confirmation.hidden = false;
    let seconds = 4;
    const label = () => { countdown.textContent = `ส่งใน ${seconds} วินาที · พิมพ์เพื่อแก้ไข`; };
    label();
    timer = setIntervalImpl(() => {
      if (--seconds <= 0) { cancelCountdown(); submit(); } else label();
    }, 1000);
  }
  send.addEventListener('click', submit);
  question.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  question.addEventListener('input', () => {
    resize();
    if (timer !== null) { cancelCountdown(); setMicStatus('แก้ไขแล้ว · กดส่งเมื่อพร้อม'); }
  });
  mic.addEventListener('click', () => { cancelCountdown(); onMic(); });
  cancel.addEventListener('click', () => { cancelCountdown(); setMicStatus('พักการส่งแล้ว · แก้ไขข้อความหรือกดส่งได้เลย'); });
  settingsToggle.addEventListener('click', () => settings.showModal());
  settingsClose.addEventListener('click', () => settings.close());
  resize();
  return { showTranscript, cancelCountdown, setMicStatus };
}
